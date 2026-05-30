# Uploads

The upload story has three shapes — pick by how big the file is and how much your server wants to touch the bytes.

| Shape | When | Where the bytes go |
|---|---|---|
| **Buffered upload** | < 10 MB, server inspects the bytes (validation, hashing, image processing) | client → app server (buffer) → `Storage` |
| **Streamed upload** | 10 MB – several GB, server doesn't need the bytes in one piece | client → app server (chunked) → `Storage` (stream) |
| **Direct-to-storage** | Multi-GB, browsers, mobile clients on slow links | client → S3 (presigned PUT URL); your server only mints the URL |

Buffered is the simplest; direct-to-storage scales the furthest. Stream is the middle ground when you need server-side processing but can't afford to hold the whole file in memory.

## Buffered upload

The Bun-native `Request.arrayBuffer()` or `Request.formData()` gets you the bytes; `storage.put()` writes them.

```ts
// app/Controllers/avatar_controller.ts
import { inject } from '@strav/kernel'
import { Storage, StoragePathError } from '@strav/storage'
import { ulid } from '@strav/kernel'
import type { HttpContext } from '@strav/http'

@inject()
export class AvatarController {
  constructor(private readonly storage: Storage) {}

  async upload(ctx: HttpContext): Promise<Response> {
    const form = await ctx.request.raw.formData()
    const file = form.get('avatar')
    if (!(file instanceof File)) {
      return ctx.response.json({ error: 'avatar field missing' }, { status: 400 })
    }
    if (file.size > 5 * 1024 * 1024) {
      return ctx.response.json({ error: 'avatar must be under 5MB' }, { status: 413 })
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return ctx.response.json({ error: 'invalid image type' }, { status: 415 })
    }

    const key = `avatars/${ctx.auth.user.id}/${ulid()}.${ext(file.type)}`
    await this.storage.put(key, file, {
      contentType: file.type,
      visibility: 'public',
    })

    await this.users.updateAvatar(ctx.auth.user.id, key)
    return ctx.response.json({ url: this.storage.publicUrl(key) })
  }
}

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function ext(mime: string): string {
  return mime.split('/')[1] ?? 'bin'
}
```

Three rules worth remembering:

- **Validate size before reading.** `file.size` from `FormData` is the declared size; you still want a hard cap because the client can lie. Bun's `Request` enforces a default body limit (10MB) — bump it with `Bun.serve({ maxRequestBodySize: ... })` if you genuinely need larger uploads here.
- **Validate type with an allowlist, not extension.** `file.type` is the MIME type the browser sent; treat it as a hint, not gospel. For security-sensitive paths (PDFs, executables), sniff magic numbers from the first 16 bytes via a library; relying on `file.type` alone lets attackers smuggle JS-in-PDF tricks.
- **Generate the key server-side.** Never write to a path the user controls (`storage.put(file.name, ...)`) — apart from collisions, attacker-supplied filenames are how path-traversal bugs land. `ulid()` + extension is the canonical pattern.

## Streamed upload

For larger payloads, skip the FormData round-trip — read the raw body as a stream and hand it to `storage.put()`:

```ts
async upload(ctx: HttpContext): Promise<Response> {
  const contentType = ctx.request.headers.get('content-type') ?? 'application/octet-stream'
  const key = `uploads/${ctx.auth.user.id}/${ulid()}.bin`

  const body = ctx.request.raw.body
  if (body === null) {
    return ctx.response.json({ error: 'empty body' }, { status: 400 })
  }
  await this.storage.put(key, body, { contentType })
  return ctx.response.json({ key })
}
```

`Request.body` is a `ReadableStream<Uint8Array>`. The S3 driver hands it to Bun's `S3Client.write()`, which translates into multipart upload chunks under the hood. LocalStorage drains the stream to a Uint8Array before writing (single-node deployments don't have the same memory-pressure concerns as cloud).

A nuance: once you've read the body as a stream, you can't read it again. If you need to validate against a checksum hash *and* store the bytes, either:

- Tee the stream — split into two pipes, one for the hasher, one for storage. Both consumers drain in parallel.
- Stage to a temp object first (`uploads/staging/<ulid>`), validate it via `storage.stat()` / `storage.get()`, then move to the final key.

Direct teeing is faster but harder to reason about; staging is the boring-correct choice for most apps.

## Direct-to-storage with presigned PUT URLs

For files that would dominate your request path — multi-GB videos, large datasets — let the client PUT straight to S3. Your server mints a signed URL; the bytes never touch your app server.

**Server — mint the URL:**

```ts
async requestUpload(ctx: HttpContext): Promise<Response> {
  const { filename, contentType, size } = await ctx.request.json()
  if (!ALLOWED_TYPES.has(contentType)) {
    return ctx.response.json({ error: 'type not allowed' }, { status: 415 })
  }
  if (size > 1024 * 1024 * 1024) {
    return ctx.response.json({ error: 'too large' }, { status: 413 })
  }

  const key = `uploads/${ctx.auth.user.id}/${ulid()}/${safeName(filename)}`
  const url = await this.storage.signedUrl(key, {
    expiresIn: 300,                       // 5 minutes to start the upload
    method: 'PUT',
  })

  await this.uploads.recordPending(ctx.auth.user.id, key, contentType, size)
  return ctx.response.json({ url, key, expiresAt: Date.now() + 300 * 1000 })
}
```

**Client — direct PUT:**

```ts
const { url, key } = await fetch('/uploads/request', {
  method: 'POST',
  body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
}).then(r => r.json())

const upload = await fetch(url, {
  method: 'PUT',
  body: file,
  headers: { 'content-type': file.type },
})
if (!upload.ok) throw new Error('upload failed')

await fetch('/uploads/finalize', {
  method: 'POST',
  body: JSON.stringify({ key }),
})
```

**Server — finalize:**

```ts
async finalize(ctx: HttpContext): Promise<Response> {
  const { key } = await ctx.request.json<{ key: string }>()
  const pending = await this.uploads.findPending(ctx.auth.user.id, key)
  if (pending === null) return ctx.response.json({ error: 'unknown key' }, { status: 404 })

  // Verify the client actually uploaded what they said they would.
  const stat = await this.storage.stat(key)
  if (stat.size !== pending.expectedSize) {
    await this.storage.delete(key)
    await this.uploads.markFailed(pending.id, 'size mismatch')
    return ctx.response.json({ error: 'size mismatch' }, { status: 400 })
  }
  if (stat.contentType !== pending.expectedContentType) {
    await this.storage.delete(key)
    await this.uploads.markFailed(pending.id, 'type mismatch')
    return ctx.response.json({ error: 'type mismatch' }, { status: 400 })
  }

  await this.uploads.markComplete(pending.id, stat.etag)
  return ctx.response.json({ ok: true })
}
```

Why the finalize step:

- **Verify the upload happened.** The signed URL gives the client a window to PUT; nothing guarantees they actually did. Without finalize you're left with database rows pointing at keys that may or may not exist.
- **Verify what they uploaded.** Without finalize, a client can request a signed URL claiming `image/jpeg` and 1 MB, then PUT a 1 GB malicious binary. `stat()` + comparison catches the lie.
- **Clean up failed uploads.** Pending rows that never finalize get a periodic sweep — anything older than 1 hour with no `markComplete` gets `storage.delete()`'d and the row removed.

## Resumable uploads

S3 supports multipart upload natively — your client can PUT chunks of a large file in parallel and resume on connection drops. Bun's `S3Client` handles multipart chunking transparently when you pass a stream or large buffer to `client.write()`, but the **resumable** semantic (paused-and-resumed across page reloads) requires explicit multipart calls that the framework doesn't expose in v1.

For multi-GB uploads with resume support today, two options:

- **Mint multiple presigned URLs** — one for each part, plus a final URL for completing the multipart upload. Roll your own with the AWS SDK or hit the S3 API directly.
- **Use a presigned POST policy** — S3's older "POST policy" mechanism includes resume hints (`X-Amz-Date`, etc.) that the client respects. Less common today but works.

For most apps, "client retries the whole upload on failure" is enough. Multi-GB-with-resume is a v2 concern.

## Tracking uploads

The pending-row pattern from the direct-to-storage example generalises:

```sql
CREATE TABLE upload (
  id text PRIMARY KEY,                 -- ULID
  user_id text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  expected_size bigint NOT NULL,
  expected_content_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',  -- pending | complete | failed
  etag text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);
CREATE INDEX ON upload (user_id, status, created_at);
```

A nightly scheduled job sweeps `status = 'pending' AND created_at < now() - interval '1 hour'`, calls `storage.delete()` on each `storage_key`, and updates the row. Without the sweep, abandoned multi-GB uploads accumulate in S3 and quietly eat your bill.

## Public assets vs private files

The `visibility` option on `storage.put()` decides:

| Visibility | S3 ACL | When |
|---|---|---|
| `'public'` | `public-read` | Avatars, marketing images, any asset that lives in a URL on a page |
| `'private'` (default) | `private` | User uploads, reports, anything that shouldn't be retrievable without auth |

For public assets, the typical flow is:

1. `storage.put(key, body, { visibility: 'public' })`
2. Store the key (not the URL) in your database.
3. Render the URL from `storage.publicUrl(key)` at template-rendering time.

The URL form decouples the storage layout from how it's served — moving to a CDN later is a `publicBase` change, no migration of stored URLs.

## Image processing

For thumbnails, resizing, format conversion — do it in a queue job, not inline in the upload handler:

```ts
// In the upload handler:
await this.storage.put(originalKey, file, { contentType: file.type, visibility: 'private' })
await this.queue.dispatch(GenerateThumbnails, { originalKey })

// In the job:
class GenerateThumbnails extends Job<{ originalKey: string }> {
  static jobName = 'images.thumbnails'

  async handle(ctx: JobContext<{ originalKey: string }>): Promise<void> {
    const original = await this.storage.get(ctx.payload.originalKey)
    for (const size of [100, 400, 800]) {
      const resized = await sharp(original).resize(size).webp().toBuffer()
      const thumbKey = ctx.payload.originalKey.replace(/\.[^.]+$/, `.${size}.webp`)
      await this.storage.put(thumbKey, resized, { contentType: 'image/webp', visibility: 'public' })
    }
  }
}
```

Two reasons to push it to the queue:

- Upload handlers should return fast. Resizing a 4K image takes 200-500ms; that's user-visible latency on the upload button.
- Failures should be retryable. If the resizer crashes on a malformed image, you don't want the upload to fail too — keep the original safe, retry the thumbnail.

## When the upload fails

Two failure modes worth handling:

**Client disconnects mid-upload.** With buffered or streamed, the request fails — your handler never reaches `storage.put()`, nothing to clean up. With presigned PUTs, the partial object lingers in S3 until your finalize sweep catches it.

**Storage rejects the write.** `storage.put()` throws `StorageDriverError`. Don't swallow — let the handler return a 502 so the client knows to retry. If the storage backend was flaky and the next attempt succeeds, no harm done.

```ts
try {
  await this.storage.put(key, body, { contentType })
} catch (err) {
  if (err instanceof StorageDriverError) {
    return ctx.response.json(
      { error: 'storage temporarily unavailable, retry' },
      { status: 502 },
    )
  }
  throw err
}
```

For batch uploads (importing N files at once), wrap each one in its own try/catch and continue — one bad file shouldn't fail the whole batch.
