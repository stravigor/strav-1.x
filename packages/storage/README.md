# @strav/storage

Object storage / filesystem abstraction for Strav 1.0. Two drivers — local filesystem and S3-compatible (AWS / R2 / B2 / Tigris / MinIO via the `endpoint` option). Apps inject the abstract `Storage` token; the provider in the container picks the concrete driver. Same dependency shape as `@strav/cache` and `@strav/broadcast`.

```ts
import { Storage } from '@strav/storage'

@inject()
class ReportsController {
  constructor(private readonly storage: Storage) {}

  async upload(req: Request): Promise<Response> {
    const body = await req.arrayBuffer()
    await this.storage.put(`reports/${ulid()}.pdf`, body, {
      contentType: 'application/pdf',
      visibility: 'private',
    })
    return new Response(null, { status: 201 })
  }

  async share(path: string): Promise<string> {
    return this.storage.signedUrl(path, { expiresIn: 3600 })
  }
}
```

Canonical docs live in [`docs/storage/README.md`](../../docs/storage/README.md).

## What ships

| Driver | Subpath | Notes |
|---|---|---|
| Local | `@strav/storage` (root) + `@strav/storage/local` | `Bun.file` + `Bun.write` + `node:fs/promises`. Single-node deployments + dev. |
| S3-compatible | `@strav/storage/s3` | Bun's built-in `S3Client` — no third-party Bun S3 client dep. Works with AWS S3, Cloudflare R2, Backblaze B2, Tigris, MinIO via the `endpoint` option. |

All paths funnel through a strict normalizer (no `../`, no absolute paths, no backslashes) so controller code stays portable between drivers. Visibility maps to S3 ACL ('public' → `public-read`, 'private' → `private`); on LocalStorage it's a hint only — apps serving uploads via a static handler get the "public" semantic for free.
