# Signed URLs

Signed URLs are S3's way of granting temporary, scoped access to a single object. The URL itself carries the signature; anyone who has the URL can use it until it expires. Used right, they're how you serve private content without proxying every byte through your app server. Used wrong, they're how private data leaks into search-engine caches.

## The three patterns

| Use case | Method | Typical expiry |
|---|---|---|
| **Download a private file** | `GET` | 5-15 minutes (long enough to start the download, short enough to limit replay) |
| **Direct-to-storage upload** | `PUT` | 5 minutes (client should start the upload immediately after receiving the URL) |
| **HEAD check before download** | `HEAD` | Same as the matching GET URL |

Public assets — avatars, marketing images — don't need signed URLs. Use `storage.publicUrl()` and let the bucket / CDN serve them directly.

## Download URLs (GET)

The most common shape: user clicks "Download" on a private file in your app; you mint a signed URL and redirect them to it.

```ts
import { inject, AuthorizationError } from '@strav/kernel'
import { Storage } from '@strav/storage'
import type { HttpContext } from '@strav/http'

@inject()
export class ReportsController {
  constructor(
    private readonly storage: Storage,
    private readonly reports: ReportsRepository,
  ) {}

  async download(ctx: HttpContext): Promise<Response> {
    const report = await this.reports.findOrFail(ctx.request.params.id)
    if (report.ownerId !== ctx.auth.user.id) {
      throw new AuthorizationError('Not your report.')
    }

    const url = await this.storage.signedUrl(report.storageKey, {
      expiresIn: 300,                      // 5 minutes
      method: 'GET',
    })
    return ctx.response.redirect(url, 302)
  }
}
```

Three things to notice:

- **Authorize first.** The signed URL bypasses your app entirely — once minted, anyone holding it can fetch the object until it expires. Verify the user has access to the file *before* you call `signedUrl()`.
- **Redirect, don't return.** Returning the URL in JSON works but exposes it to your logs, browser history, JavaScript that may persist it. A 302 takes the browser straight to the URL without leaving a trace your app controls.
- **Short expiry.** 5 minutes is enough to start a large download (HTTP keeps the connection open even after the URL expires). Longer expiries are tempting and almost always wrong — see "When the URL leaks" below.

## Upload URLs (PUT)

The direct-to-storage pattern covered in [`uploads.md`](./uploads.md) — your server signs the URL, the client PUTs straight to S3.

```ts
const url = await storage.signedUrl(`uploads/${ulid()}.bin`, {
  expiresIn: 300,
  method: 'PUT',
})
```

The client then:

```ts
await fetch(url, {
  method: 'PUT',
  body: file,
  headers: { 'content-type': file.type },
})
```

**Constraints worth knowing:**

- The presigned URL is bound to the method you signed it for. A `PUT` URL refuses `GET` requests and vice versa.
- The URL is bound to the exact key — clients can't redirect uploads to a different path.
- S3 doesn't enforce `Content-Type` matching by default. Your finalize step (per the upload guide) should `stat()` the object and verify what the client actually uploaded matches what they declared.

## Expiry strategy

The default Bun `S3Client` accepts any `expiresIn` value in seconds. Two competing pressures:

- **Too short** — the URL stops working mid-download / mid-upload. Bad UX.
- **Too long** — leaked URLs grant access for too long.

Reasonable defaults:

| Scenario | `expiresIn` |
|---|---|
| One-off download click | 300 (5 min) |
| Email "click here to view your invoice" | 86400 (24 h) |
| Direct PUT upload | 300 (5 min) — client starts immediately |
| Embedded `<img>` for a private dashboard | 3600 (1 h) — page reload re-mints |
| API client that polls and re-mints | 60 (1 min) — paranoid mode |

Long expiry only makes sense when the URL is the artifact (an emailed link the user opens later). For URLs the browser holds in memory, short + re-minted on demand is safer.

## When the URL leaks

Signed URLs ARE the auth — anyone holding one can fetch the object until expiry. Three vectors where they leak:

- **Server logs.** Don't log URLs. If you must log "user X requested object Y", log the key, not the signed URL.
- **Referer headers.** If a signed URL is on a page that the user clicks a link from, the destination site receives the signed URL in `Referer`. Set `Referrer-Policy: no-referrer` on responses that embed signed URLs to suppress this.
- **Browser history.** URLs the user navigated to land in history; URLs fetched programmatically don't. Prefer XHR/`fetch` over `<a href>` when the URL is sensitive, OR redirect (302) so the URL never appears in your app's address bar.

For high-sensitivity content (medical records, financial documents):

- Pick the shortest expiry that works (60-300 seconds).
- Mint a fresh URL per click.
- Log the *act of minting* (with the user id, key, and a coarse timestamp) for audit; never log the URL itself.

## `responseContentType` override

S3 lets you override the `Content-Type` header returned by a signed GET — useful for forcing downloads or correcting upload-time mistakes:

```ts
const url = await storage.signedUrl('docs/report.bin', {
  expiresIn: 300,
  method: 'GET',
  responseContentType: 'application/pdf',
})
```

The bytes are unchanged; only the response header differs. This is how Stripe-style "open the invoice in a new tab" buttons work — the file is stored as `application/octet-stream` to prevent accidental browser preview during admin tooling, then served with the right type when a real user requests it.

`LocalStorage.signedUrl()` always throws — there's no signing authority on the local filesystem. Use the S3 driver (with MinIO in dev) when your code paths exercise signed URLs.

## Versus public URLs

| Aspect | `publicUrl()` | `signedUrl()` |
|---|---|---|
| **Who can fetch** | Anyone | Anyone with the URL, until expiry |
| **Expires** | Never | Yes |
| **CDN cacheable** | Yes (immutable URL) | Yes BUT the cache hit window is short and per-URL |
| **Per-request server work** | None — URL is constant | A signing call per request |
| **Auth check before** | Optional — the bucket is public | Mandatory — the URL IS the auth |

Use `publicUrl` for everything that's truly public — there's no scenario where signing a public asset's URL helps. Use `signedUrl` for everything else.

For mixed content (a page with a public banner and a private chart), call both: render the banner via `publicUrl`, mint the chart's `signedUrl` server-side at request time.

## Versus proxying through your app

The alternative to signed URLs: stream the bytes through your app server.

```ts
async download(ctx: HttpContext): Promise<Response> {
  const report = await this.reports.findOrFail(ctx.request.params.id)
  if (report.ownerId !== ctx.auth.user.id) {
    throw new AuthorizationError('Not your report.')
  }
  const stream = await this.storage.getStream(report.storageKey)
  return new Response(stream, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${report.filename}"`,
    },
  })
}
```

When to proxy:

- **You need to modify the bytes on the way through** — add a watermark, decrypt with a user-specific key, etc.
- **The auth check is per-byte** — e.g. range requests where each chunk needs reauthorization. (Rare.)
- **You want consistent CDN behaviour** — your CDN already caches `/reports/:id` responses; switching to signed URLs would bypass that layer.

When to use signed URLs:

- **The file is big** — proxying gigabytes through your app costs bandwidth twice (download from S3, upload to client).
- **You need horizontal scale** — every proxied byte ties up an HTTP connection on your app server. Signed URLs offload that to S3.
- **The CDN doesn't help** — first-fetch performance dominates because the same URL is rarely fetched twice.

For most apps: signed URLs are the default; proxy when you need the byte stream.

## Testing signed URLs

The S3 driver's `signedUrl()` is exercised in `packages/storage/tests/drivers/s3_storage.test.ts` — the test fetches the returned URL and asserts the body comes back. Same pattern works in your app:

```ts
test('download endpoint returns a fetchable signed URL', async () => {
  const { app, seedReport } = await bootTestApp()
  const report = await seedReport({ owner: alice, storageKey: 'reports/r1.pdf' })

  const res = await app.fetch(new Request(`http://x/reports/${report.id}/download`, {
    headers: { authorization: `Bearer ${aliceToken}` },
    redirect: 'manual',                            // capture the 302 before it follows
  }))

  expect(res.status).toBe(302)
  const signed = res.headers.get('location')!
  expect(signed).toContain('X-Amz-Signature')

  const fetched = await fetch(signed)
  expect(fetched.ok).toBe(true)
})
```

Run this against MinIO via `docker-compose up -d minio` + the `S3_*` env vars from `.env.test.example`. Self-skip when `S3_ENDPOINT` is unset.

## Limits

- **Bun's `S3Client.presign()` doesn't expose multipart upload URLs.** For files >5GB you need multipart, and that means calling the S3 multipart APIs directly (initiate / put-part / complete). v1 of `@strav/storage` doesn't expose those primitives.
- **No POST policy support.** S3's older POST-policy presign (which lets the client upload via a `<form>` with a signed policy document) isn't on Bun's surface. PUT-presign covers the same ground for most apps.
- **No conditional headers in the signature.** AWS supports `x-amz-server-side-encryption` and similar headers as part of the signature; Bun's `presign()` accepts a method + expiry only. For most apps this doesn't matter.
