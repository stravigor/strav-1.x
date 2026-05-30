# Testing storage

Three test shapes cover ~95% of what apps need:

| Shape | When | Setup |
|---|---|---|
| **LocalStorage against a tmpdir** | Unit + integration tests for code that calls `Storage` methods | `createTempStorageRoot()` from `@strav/testing/storage` |
| **MinIO via docker-compose** | Integration tests for code that depends on S3-specific behaviour (signed URLs, ACLs, content-type round-trip) | `docker-compose up -d minio` + `S3_*` env vars |
| **Inline `Storage` stub** | Unit tests for code paths where you want to assert "did the controller call `storage.put` with X args?" | Hand-rolled class implementing the bits of `Storage` you use |

For pure logic (validators, formatters, services that don't touch storage), no setup — inject `null` or `undefined` for the storage dep.

## LocalStorage with tmpdirs

The cheapest and most representative shape. `@strav/testing/storage` ships a helper:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LocalStorage } from '@strav/storage'
import { createTempStorageRoot, type TempStorageRoot } from '@strav/testing'

let temp: TempStorageRoot
let storage: LocalStorage

beforeAll(async () => {
  temp = await createTempStorageRoot()
  storage = new LocalStorage({ root: temp.path, publicBase: 'http://localhost:3000/files' })
})

afterAll(async () => {
  await temp.cleanup()
})

test('upload happy path round-trips a file', async () => {
  await storage.put('avatars/u_1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  expect(await storage.exists('avatars/u_1.png')).toBe(true)
  const bytes = await storage.get('avatars/u_1.png')
  expect(bytes.length).toBe(4)
})
```

`createTempStorageRoot()` does `mkdtemp(os.tmpdir() + '/strav-storage-')` and returns the path + a cleanup function. The cleanup is `rm -rf` on the temp dir — safe even if the test crashed midway through.

For tests that exercise multiple drivers (e.g. testing your `TenantStorage` wrapper works the same against Local + S3), parameterise:

```ts
const drivers = [
  ['LocalStorage', () => Promise.resolve(new LocalStorage({ root: temp.path }))],
  ...(await isS3Available() ? [['S3Storage', () => Promise.resolve(makeS3Storage())]] : []),
] as const

for (const [name, makeStorage] of drivers) {
  describe(`TenantStorage on ${name}`, () => {
    let storage: Storage
    beforeAll(async () => {
      storage = await makeStorage()
    })
    // ... tests using `storage` ...
  })
}
```

The driver-skip pattern keeps the suite green on machines without MinIO running — `await isS3Available()` self-skips the S3 cases.

## MinIO via docker-compose

For tests that need S3 semantics (signed URLs, server-side copy, multipart upload, ACL mapping), point at MinIO. The `docker-compose.yml` in this repo ships it; `.env.test.example` has the env vars.

```bash
docker-compose up -d minio
source .env.test
bun test packages/storage/tests/drivers/s3_storage.test.ts
```

The pattern your tests use:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { S3Storage } from '@strav/storage/s3'
import { ensureS3Bucket, isS3Available } from '@strav/testing'

const AVAILABLE = await isS3Available()

describe.skipIf(!AVAILABLE)('S3 integration', () => {
  let storage: S3Storage
  const PREFIX = `test-${Date.now()}/`            // per-run prefix so parallel suites don't collide

  beforeAll(async () => {
    await ensureS3Bucket()
    storage = new S3Storage({
      endpoint: process.env.S3_ENDPOINT ?? '',
      bucket: process.env.S3_BUCKET ?? '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    })
  })

  afterAll(async () => {
    // Sweep everything we wrote under PREFIX.
    const result = await storage.list({ prefix: PREFIX, recursive: true, limit: 1000 })
    for (const entry of result.entries) {
      if (entry.isDirectory) continue
      try {
        await storage.delete(entry.path)
      } catch {
        // Continue — partial cleanup is fine.
      }
    }
  })

  test('signed URL round-trips a private object', async () => {
    await storage.put(`${PREFIX}r.pdf`, new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      contentType: 'application/pdf',
    })
    const url = await storage.signedUrl(`${PREFIX}r.pdf`, { expiresIn: 60 })
    const res = await fetch(url)
    expect(res.ok).toBe(true)
    expect(await res.bytes()).toHaveLength(4)
  })
})
```

Three patterns worth keeping:

- **Per-run prefix.** Multiple suites running against the same bucket would clobber each other; `test-${Date.now()}/` (or `test-${crypto.randomUUID()}/`) keeps them apart.
- **`describe.skipIf(!AVAILABLE)`.** Tests self-skip when MinIO isn't running. Run-locally-without-docker stays painless.
- **Cleanup in `afterAll`, not per-test.** Per-test deletion costs round-trips; per-run cleanup keeps the suite fast and leaves diagnostic traces if a test fails mid-run.

`isS3Available()` caches its result for the process lifetime — first call probes, subsequent calls are O(1).

## Stubbing `Storage` for unit tests

For tests where the storage backend doesn't matter — you just want to assert "did the controller call `storage.put('avatars/X', bytes)?`" — roll your own.

```ts
class StubStorage extends Storage {
  readonly writes: { path: string; bytes: Uint8Array; options?: PutOptions }[] = []
  readonly objects = new Map<string, Uint8Array>()

  override async put(path: string, contents: unknown, options?: PutOptions): Promise<void> {
    const bytes = await coerceBytes(contents)
    this.writes.push({ path, bytes, ...(options ? { options } : {}) })
    this.objects.set(path, bytes)
  }

  override async get(path: string): Promise<Uint8Array> {
    const found = this.objects.get(path)
    if (found === undefined) {
      throw new StorageNotFoundError(`StubStorage: no object at "${path}".`)
    }
    return found
  }

  override async exists(path: string): Promise<boolean> {
    return this.objects.has(path)
  }

  override async delete(path: string): Promise<boolean> {
    return this.objects.delete(path)
  }

  override publicUrl(path: string): string {
    return `stub://${path}`
  }

  // ... stub the rest as needed; tests only need the bits they call.
}

async function coerceBytes(contents: unknown): Promise<Uint8Array> {
  if (typeof contents === 'string') return new TextEncoder().encode(contents)
  if (contents instanceof Uint8Array) return contents
  if (contents instanceof ArrayBuffer) return new Uint8Array(contents)
  if (contents instanceof Blob) return new Uint8Array(await contents.arrayBuffer())
  throw new Error('StubStorage: unsupported contents type')
}
```

Wire it into your test container as the `Storage` binding:

```ts
const stub = new StubStorage()
const { app, signup } = await bootTestApp({
  providers: [
    {
      name: 'storage',
      register(app) {
        app.singleton(Storage, () => stub)
      },
      async boot() {},
    },
  ],
})

await signup({ avatar: pngBytes })

expect(stub.writes).toHaveLength(1)
expect(stub.writes[0]?.path).toMatch(/^avatars\/u_[a-z0-9]+\/[A-Z0-9]{26}\.png$/)
expect(stub.writes[0]?.options?.visibility).toBe('public')
```

When the stub gets bigger than ~50 LOC, switch to `LocalStorage` against a tmpdir — the stub becomes a maintenance burden and the test coverage is the same. Reach for stubs when you specifically want to inspect call arguments (was the right `visibility` set? was the key formatted correctly?) and pivot to LocalStorage when you want to verify the file actually exists and is readable.

## Testing upload handlers end-to-end

Combine the HTTP test client with one of the storage shapes above:

```ts
test('POST /avatars stores the upload + returns the public URL', async () => {
  const { app } = await bootTestApp()
  const form = new FormData()
  form.set('avatar', new File([pngBytes], 'me.png', { type: 'image/png' }))

  const res = await app.fetch(new Request('http://x/avatars', {
    method: 'POST',
    body: form,
    headers: { authorization: `Bearer ${aliceToken}` },
  }))

  expect(res.status).toBe(200)
  const { url } = await res.json<{ url: string }>()

  // For LocalStorage tests, fetch via the configured publicBase + your
  // static-handler. For S3 tests, fetch the URL directly:
  const fetched = await fetch(url)
  expect(fetched.ok).toBe(true)
  expect(await fetched.bytes()).toEqual(pngBytes)
})
```

The shape of the test doesn't change between drivers — both expose the same `publicUrl(...)` contract.

## Asserting on rejection paths

Path safety is enforced before any backend call. Tests can assert this without spinning up storage:

```ts
test('rejects path-traversal attempts on upload', async () => {
  const { app } = await bootTestApp()
  const form = new FormData()
  form.set('avatar', new File([pngBytes], '../etc/passwd.png', { type: 'image/png' }))

  const res = await app.fetch(new Request('http://x/avatars', { method: 'POST', body: form }))
  // The controller should generate the key server-side, not pass `file.name`
  // straight through — so this should succeed (the user's filename is ignored).
  expect(res.status).toBe(200)
})
```

For tests that DO pass user input to `Storage`, assert on the `StoragePathError`:

```ts
import { StoragePathError } from '@strav/storage'

test('storage rejects ../ in any path arg', async () => {
  await expect(storage.put('../escape.txt', 'x')).rejects.toBeInstanceOf(StoragePathError)
  await expect(storage.get('../etc/passwd')).rejects.toBeInstanceOf(StoragePathError)
  await expect(storage.delete('/abs.txt')).rejects.toBeInstanceOf(StoragePathError)
})
```

The framework's path normalizer makes these reject *before* the backend call — even on `delete()` for a path the bucket would have happily ignored.

## Coverage targets

- **LocalStorage suite** — every method (`get`/`put`/`exists`/`stat`/`delete`/`copy`/`move`/`list`/`publicUrl`) at least once. The package's own tests in `packages/storage/tests/drivers/local_storage.test.ts` are the reference; mirror that shape for your wrapper classes.
- **S3 suite** — driver-specific things the LocalStorage suite can't cover: signed URLs (fetch + assert), ACL round-trip (put public, fetch via `publicUrl`), content-type round-trip (put with type, stat returns it), copy of large objects.
- **End-to-end** — at least one test per upload endpoint that exercises the full pipeline (HTTP → controller → `Storage` → assertion on `publicUrl` / DB row).

For most apps, that's 6-15 tests total for storage. The S3 driver's behaviour is well-covered by `@strav/storage`'s own suite — you're testing *your code that uses Storage*, not the framework.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Tests pass locally, fail in CI | CI doesn't run MinIO | `describe.skipIf(!isS3Available)`. Pin the suite to skip cleanly when the service is missing. |
| `EBUSY` errors in tmpdir cleanup | A previous test held a file open | `await` every `Storage` call. Don't fire-and-forget. |
| Cross-test contamination | Same tmpdir reused; tests in same file share state | Move `createTempStorageRoot` into the `describe`'s `beforeAll` (not module-level) for full isolation. |
| `Storage` token resolves to the production driver in tests | Boot order — production provider registers first | Test-mode providers re-register `Storage` AFTER the production one. Last-write wins in the container. |
