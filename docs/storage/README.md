# @strav/storage

Object storage / filesystem abstraction. The package exposes the `Storage` abstraction every consumer injects, plus two concrete drivers — `LocalStorage` (single-node filesystem) and `S3Storage` (AWS S3 + R2 + B2 + Tigris + MinIO via the `endpoint` option). Apps swap providers in `bootstrap/providers.ts`; controllers stay driver-agnostic.

> **Status: 1.0.0-alpha.** Both drivers ship the full Storage surface (`get`/`put`/`exists`/`stat`/`delete`/`copy`/`move`/`list`/`publicUrl`/`signedUrl`) plus streaming variants. No third-party storage client dependency — S3 uses Bun's built-in `S3Client` (since Bun 1.2). Lives in its own package rather than `@strav/kernel` so the kernel stays free of subsystem-specific code; same dependency shape as `@strav/cache` and `@strav/broadcast`.

## What's here

| Export | Notes |
|---|---|
| `Storage` | Abstract base + container token. Subclasses MUST override the primitives (`get`/`put`/`exists`/`stat`/`delete`/`copy`/`list`/`publicUrl`/`signedUrl`); base provides `getString` / `getStream` / `move` / `close` |
| `LocalStorage` | Filesystem driver. Uses `Bun.file` + `Bun.write` + `node:fs/promises`. Per-key visibility is a hint only |
| `S3Storage` (subpath) | S3-compatible driver via Bun's `S3Client`. Custom endpoint for non-AWS providers |
| `StorageProvider` | Default — binds `LocalStorage` under the `Storage` token from `config.storage` |
| `S3StorageProvider` (subpath) | Binds `S3Storage` under the same token |
| `normalizePath` / `normalizePrefix` | Path safety helpers exported for driver authors |
| `StorageError` + `StorageConfigError` / `StorageDriverError` / `StorageNotFoundError` / `StoragePathError` | Typed error hierarchy with stable `code`s |
| `StorageWriteable` / `PutOptions` / `StorageStat` / `ListOptions` / `ListResult` / `ListEntry` / `SignedUrlOptions` | Public types |

## Install

```bash
bun add @strav/storage
```

## Minimal example — local filesystem

```ts
// config/storage.ts
import type { LocalStorageConfig } from '@strav/storage'

export default {
  driver: 'local',
  root: 'storage/uploads',
  publicBase: process.env.STORAGE_PUBLIC_BASE,   // 'https://cdn.acme.com' or omit
} satisfies LocalStorageConfig
```

```ts
// bootstrap/providers.ts
import { ConfigProvider, LoggerProvider } from '@strav/kernel'
import { StorageProvider } from '@strav/storage'

export default [
  new ConfigProvider({ /* ... */ }),
  new LoggerProvider(),
  new StorageProvider(),
]
```

```ts
import { Storage } from '@strav/storage'
import { inject } from '@strav/kernel'

@inject()
class ReportsController {
  constructor(private readonly storage: Storage) {}

  async store(name: string, body: Uint8Array): Promise<void> {
    await this.storage.put(`reports/${name}`, body, {
      contentType: 'application/pdf',
      visibility: 'private',
    })
  }

  async show(name: string): Promise<Uint8Array> {
    return this.storage.get(`reports/${name}`)
  }
}
```

## Multi-node — S3 (or R2 / B2 / Tigris / MinIO)

```ts
import { S3StorageProvider } from '@strav/storage/s3'

// bootstrap/providers.ts
export default [
  new ConfigProvider({ /* ... */ }),
  new LoggerProvider(),
  new S3StorageProvider(),
]
```

```ts
// config/storage.ts
import type { S3StorageConfig } from '@strav/storage/s3'

export default {
  driver: 's3',
  bucket: process.env.S3_BUCKET ?? '',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  region: process.env.S3_REGION ?? 'us-east-1',
  // endpoint: omit for AWS; set for everything else:
  //   Cloudflare R2:  https://<account>.r2.cloudflarestorage.com
  //   Backblaze B2:   https://s3.<region>.backblazeb2.com
  //   Tigris:         https://t3.storage.dev
  //   MinIO (local):  http://localhost:9000
  endpoint: process.env.S3_ENDPOINT,
  publicBase: process.env.S3_PUBLIC_BASE,   // r2.dev URL, CDN, etc.
} satisfies S3StorageConfig
```

App code doesn't change — `Storage` resolves to `S3Storage` in prod, `LocalStorage` in dev.

## Basic operations

```ts
// Reads
const bytes = await storage.get('reports/q1.pdf')              // Uint8Array
const text  = await storage.getString('config.json')           // UTF-8 decoded
const stream = await storage.getStream('large/video.mp4')      // ReadableStream<Uint8Array>

// Writes — accepts string / Uint8Array / ArrayBuffer / Blob / ReadableStream
await storage.put('docs/readme.md', '# hello')
await storage.put('avatar.png', pngBytes, { contentType: 'image/png', visibility: 'public' })
await storage.put('uploads/big.bin', incomingStream)            // streamed; bounded by chunk size

// Metadata
await storage.exists('docs/readme.md')                          // boolean
const stat = await storage.stat('avatar.png')
//   { size, lastModified, contentType?, etag? }

// Lifecycle
await storage.delete('temp.txt')                                // true if removed
await storage.copy('docs/draft.md', 'docs/published.md')
await storage.move('uploads/a.bin', 'archive/2026/a.bin')       // copy + delete; FS uses rename
```

## Listing

```ts
const result = await storage.list({
  prefix: 'reports/2026/',
  recursive: false,                                              // direct children only
  limit: 100,
})
// result.entries[i] = { path, size?, lastModified?, isDirectory? }
// result.cursor — pass back as `after` for the next page

const next = await storage.list({
  prefix: 'reports/2026/',
  after: result.cursor,
})
```

- `recursive: false` (default) returns direct children only. Subdirectories surface as `isDirectory: true` entries; their contents don't appear in the same page.
- `recursive: true` walks into every subdirectory and returns a flat list.
- Cursor pagination — `cursor` rides on `ListResult` only when more results exist; pass it back as `after`.
- S3 uses `delimiter: '/'` under the hood for `recursive: false`, so common prefixes surface as `isDirectory: true` entries. LocalStorage matches the same semantic.

## Public URLs

```ts
storage.publicUrl('avatar.png')
// → 'https://cdn.acme.com/avatar.png'
// throws StorageDriverError if `publicBase` is unset
```

`publicBase` is configured at driver-init time. For S3 this is typically:
- AWS: `https://<bucket>.s3.<region>.amazonaws.com`
- R2:  the `r2.dev` URL or a custom domain
- B2:  `https://<bucket>.s3.<region>.backblazeb2.com`

For LocalStorage it's whatever URL your static handler serves `root` at — e.g. `http://localhost:3000/files` if you mount the uploads directory at `/files`.

`storage.put(path, body, { visibility: 'public' })` flips the S3 ACL to `public-read`; on LocalStorage the option is a hint only (filesystem permissions don't map cleanly across deployments).

## Signed URLs (S3 only)

```ts
const url = await storage.signedUrl('reports/q1.pdf', { expiresIn: 3600 })
// → 'https://<bucket>.s3.<region>.amazonaws.com/reports/q1.pdf?X-Amz-Signature=…&X-Amz-Expires=3600&…'

// Upload URL — let the client PUT directly to S3:
const uploadUrl = await storage.signedUrl(`uploads/${ulid()}.bin`, {
  expiresIn: 300,
  method: 'PUT',
})
```

`LocalStorage.signedUrl()` throws `StorageDriverError` — there's no signing authority. Apps that need signed URLs in dev should run MinIO via `docker-compose` and use the S3 driver.

## Path conventions

POSIX-style only. The path normalizer enforces:

- No `..` segments anywhere (even `a/../b` is rejected — collapsing would conflate two distinct caller intents)
- No absolute paths (leading `/`)
- No backslashes (Windows callers can't smuggle path-segment confusion past S3 → FS portability)
- No empty segments (`a//b`)
- No `.` segments
- No control characters

Throws `StoragePathError` on rejection. Apps don't need to validate paths before passing them to `Storage` — the driver handles it on every public method.

## Storage limitations

`PutOptions` exposes `cacheControl` and `metadata` for forward-compatibility, but Bun's current `S3Options` surface doesn't plumb them through. Today the S3 driver silently drops them; documented here rather than throwing so apps don't need migration when Bun adds support. Local storage doesn't honour any of the metadata options — it stores bytes, nothing else.

## Guides

- [`guides/uploads.md`](./guides/uploads.md) — buffered / streamed / direct-to-storage upload patterns, server-side validation, presigned PUT URLs + finalize flow, image processing in queue jobs.
- [`guides/signed_urls.md`](./guides/signed_urls.md) — GET / PUT / HEAD signed URLs, expiry strategy, leak vectors (logs / Referer / browser history), `responseContentType` override, when to proxy vs sign.
- [`guides/multi_tenancy.md`](./guides/multi_tenancy.md) — prefix-per-tenant (default) vs bucket-per-tenant vs account-per-tenant, the `TenantStorage` wrapper pattern, cross-tenant admin operations, tenant deletion, public-URL tenant-id leak mitigation.
- [`guides/testing.md`](./guides/testing.md) — LocalStorage with tmpdirs, MinIO via docker-compose, `StubStorage` for unit tests, asserting on path-safety rejections, coverage targets.

## When NOT to use the abstraction

- **Cache** — use `@strav/cache` (TTLs, atomic increments, distributed locks, tagged invalidation). Storage is for objects that persist; cache is for objects that expire.
- **Logs** — write to a file directly (or via your `Logger` channel). Storage's API surface (signed URLs, ACLs, lists) is overkill for append-only log streams.
- **Database blobs** — small structured payloads belong in Postgres `bytea` or `jsonb`. Storage is for files that have their own URLs and lifecycle.

## Pairs with

- **`@strav/cache`** — both packages mirror each other's dependency shape (kernel-free root, subpath drivers, optional peer deps). Apps registering one usually register the other.
- **`@strav/http`'s `ctx.response.stream(stream)` / `ctx.response.download(path)`** — pair `storage.getStream(path)` with these to ship files without buffering.
- **`@strav/queue`** — background-process large uploads (transcode video, generate thumbnails). The job picks up a key, calls `storage.get(key)`, processes, calls `storage.put(processedKey, output)`.
