# `@strav/storage` API

Public exports + semantics. Pairs with the [README](./README.md) overview.

## Root barrel — `@strav/storage`

### `class Storage`

```ts
class Storage {
  // Driver primitives — subclasses MUST override.
  get(path: string): Promise<Uint8Array>
  put(path: string, contents: StorageWriteable, options?: PutOptions): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<StorageStat>
  delete(path: string): Promise<boolean>          // true if a row was actually removed
  copy(from: string, to: string): Promise<void>
  list(options?: ListOptions): Promise<ListResult>
  publicUrl(path: string): string                 // throws when publicBase is unset
  signedUrl(path: string, options: SignedUrlOptions): Promise<string>

  // Base-class compositions.
  getString(path: string): Promise<string>        // UTF-8 decoded `get`
  getStream(path: string): Promise<ReadableStream<Uint8Array>>
  move(from: string, to: string): Promise<void>   // copy + delete by default

  // Resource cleanup. Default no-op.
  close(): Promise<void>
}
```

Container token + abstract base. Non-`abstract` so it serves as a singleton key (same trade-off as `Cache` / `Broadcaster` / `Logger`). All path arguments funnel through `normalizePath` before reaching the driver — `../`, absolute paths, backslashes, empty segments, `.` segments, and control characters are rejected with `StoragePathError`.

**Semantics every driver guarantees:**

- `get` / `getString` / `getStream` throw `StorageNotFoundError` on missing keys.
- `put` overwrites. Accepts `string` / `Uint8Array` / `ArrayBuffer` / `Blob` / `ReadableStream<Uint8Array>`. Stream payloads are consumed lazily by drivers with native streaming (S3 multipart) and buffered by drivers without (LocalStorage drains to a Uint8Array first).
- `exists` returns `false` for missing keys (never throws on that path).
- `stat` throws `StorageNotFoundError` on missing keys.
- `delete` returns `true` iff a real object was removed; missing keys return `false` (idempotent).
- `copy` throws `StorageNotFoundError` if the source is missing; auto-creates intermediate destination directories on FS.
- `move` defaults to `copy` + `delete`; LocalStorage overrides with `fs.rename` (with EXDEV fallback to copy+delete).
- `list` returns a flat array; `cursor` only present when more results exist.
- `publicUrl` throws `StorageDriverError` when no `publicBase` is configured.
- `signedUrl` requires an `expiresIn`; LocalStorage always throws (no signing authority).

### Types

```ts
type StorageWriteable =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>

interface PutOptions {
  contentType?: string
  cacheControl?: string                // forward-compat; dropped by current Bun S3
  contentEncoding?: string
  metadata?: Record<string, string>    // forward-compat; dropped by current Bun S3
  visibility?: 'private' | 'public'    // default 'private'
}

interface StorageStat {
  size: number
  lastModified: Date
  contentType?: string
  etag?: string
}

interface ListOptions {
  prefix?: string                       // POSIX-style; trailing '/' allowed
  after?: string                        // cursor from previous ListResult
  limit?: number                        // default 100, max 1000
  recursive?: boolean                   // default false
}

interface ListEntry {
  path: string
  size?: number
  lastModified?: Date
  isDirectory?: boolean                 // true for common prefixes / subdirectories
}

interface ListResult {
  entries: ListEntry[]
  cursor?: string                       // pass back as `after` for the next page
}

interface SignedUrlOptions {
  expiresIn: number                     // seconds; required
  method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  responseContentType?: string          // override Content-Type on GET (S3 only)
}
```

### Errors

- `StorageError` — base (`storage.error`, status 500).
- `StorageConfigError` — provider boot (`storage.config`, 500).
- `StorageDriverError` — driver-side I/O failure (`storage.driver`, 502).
- `StorageNotFoundError` — missing key on `get`/`stat`/`copy`/`move` (`storage.not_found`, 404).
- `StoragePathError` — path normalization rejection (`storage.path`, 400).

### `normalizePath` / `normalizePrefix`

```ts
function normalizePath(input: string): string
function normalizePrefix(input: string): string
```

Exported for driver authors. `normalizePath` enforces the safety rules above; `normalizePrefix` is the same but tolerates a trailing `/` (prefixes describe ranges, not individual objects, and `reports/2026/` is the natural shape).

### `LocalStorage`

```ts
class LocalStorage extends Storage {
  constructor(options: LocalStorageOptions)
}

interface LocalStorageOptions {
  root: string                          // absolute filesystem root
  publicBase?: string                   // URL prefix `publicUrl()` prepends
}
```

Filesystem driver backed by `Bun.file` + `Bun.write` + `node:fs/promises`. Parent directories are created on demand. ReadableStream payloads are drained to a Uint8Array before write (in-memory) — for very large uploads, prefer the S3 driver.

`visibility` is recorded but not enforced — POSIX mode bits don't map cleanly to "public vs private". Apps that serve uploads via a static handler get the "public" semantic for free.

`signedUrl` always throws — there's no signing authority on a local filesystem.

### `StorageProvider`

```ts
class StorageProvider extends ServiceProvider {
  name = 'storage'
  dependencies = ['config']
}

interface LocalStorageConfig extends LocalStorageOptions {
  driver: 'local'
}
```

Binds `LocalStorage` under the `Storage` token. Reads `config.storage` (driver: 'local'); errors out at provider boot if `root` is missing.

## `@strav/storage/local`

Re-exports `LocalStorage` + `LocalStorageOptions` for explicit construction (when an app wires its own provider).

## `@strav/storage/s3`

```ts
class S3Storage extends Storage {
  constructor(options: S3StorageOptions)
}

interface S3StorageOptions {
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  region?: string                       // AWS uses this; non-AWS providers usually ignore
  endpoint?: string                     // required for non-AWS providers
  sessionToken?: string                 // STS session token
  virtualHostedStyle?: boolean          // force virtual-hosted vs path-style URLs
  publicBase?: string                   // URL `publicUrl()` prepends; throws when unset
  client?: import('bun').S3Client       // pre-constructed for tests
}

class S3StorageProvider extends ServiceProvider {
  name = 'storage'
  dependencies = ['config']
}

interface S3StorageConfig extends Omit<S3StorageOptions, 'client'> {
  driver: 's3'
}
```

S3-compatible driver via Bun's built-in `S3Client`. Works with AWS S3, Cloudflare R2, Backblaze B2, Tigris, and MinIO via the `endpoint` option.

**Endpoint examples:**

| Provider | Endpoint |
|---|---|
| AWS S3 | omit (defaults to AWS) |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| Tigris | `https://t3.storage.dev` |
| MinIO (local dev) | `http://localhost:9000` |

**Visibility mapping** (`PutOptions.visibility`):

| Strav | S3 ACL |
|---|---|
| `'public'` | `'public-read'` |
| `'private'` | `'private'` (also the default) |

**`copy`** — Bun's S3 surface doesn't expose a single-call `copyObject`. The driver writes the destination by passing the source `S3File` to `client.write(toKey, sourceFile)`, which Bun translates into the appropriate copy operation when possible.

**`signedUrl`** uses Bun's `client.presign(key, { expiresIn, method })`. The returned URL is fetchable directly — no auth headers, no Strav-specific framing.

**`stat`** populates `contentType` + `etag` from the S3 response. `lastModified` is the object's S3-side `LastModified` header parsed to a `Date`.

**Known limits today.** Bun's `S3Options` surface doesn't expose `cacheControl` or user metadata as of Bun 1.3.14. `PutOptions.cacheControl` and `PutOptions.metadata` are silently dropped by the S3 driver; the type surface keeps them for forward compatibility so app code doesn't change when Bun adds support.
