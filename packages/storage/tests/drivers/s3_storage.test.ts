import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ensureS3Bucket, isS3Available } from '@strav/testing'
import { S3Storage } from '../../src/drivers/s3/index.ts'
import { StorageDriverError, StorageNotFoundError, StoragePathError } from '../../src/index.ts'

const AVAILABLE = await isS3Available()

describe.skipIf(!AVAILABLE)('S3Storage — MinIO integration', () => {
  let storage: S3Storage
  const PREFIX = `storage-test-${Date.now()}/`
  // Env is validated by isS3Available() above — anything reaching this
  // describe block has the four required vars set.
  const env = {
    endpoint: process.env.S3_ENDPOINT ?? '',
    bucket: process.env.S3_BUCKET ?? '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    region: process.env.S3_REGION ?? 'us-east-1',
  }

  beforeAll(async () => {
    await ensureS3Bucket()
    storage = new S3Storage({
      endpoint: env.endpoint,
      bucket: env.bucket,
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
      region: env.region,
      publicBase: `${env.endpoint}/${env.bucket}`,
    })
  })

  afterAll(async () => {
    // Best-effort cleanup of everything we wrote under our prefix.
    const list = await storage.list({ prefix: PREFIX, recursive: true, limit: 1000 })
    for (const entry of list.entries) {
      if (entry.isDirectory) continue
      try {
        await storage.delete(entry.path)
      } catch {
        // continue
      }
    }
  })

  // ─── Primitives ──────────────────────────────────────────────────────────

  test('put + get round-trips a string', async () => {
    await storage.put(`${PREFIX}rt-string.txt`, 'hello-s3')
    expect(await storage.getString(`${PREFIX}rt-string.txt`)).toBe('hello-s3')
  })

  test('put + get round-trips Uint8Array bytes', async () => {
    await storage.put(`${PREFIX}rt-bytes.bin`, new Uint8Array([10, 20, 30, 40]))
    const bytes = await storage.get(`${PREFIX}rt-bytes.bin`)
    expect([...bytes]).toEqual([10, 20, 30, 40])
  })

  test('put + get round-trips a Blob', async () => {
    await storage.put(`${PREFIX}rt-blob.txt`, new Blob(['blob-s3']))
    expect(await storage.getString(`${PREFIX}rt-blob.txt`)).toBe('blob-s3')
  })

  test('put + get round-trips a ReadableStream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed-'))
        controller.enqueue(new TextEncoder().encode('s3'))
        controller.close()
      },
    })
    await storage.put(`${PREFIX}rt-stream.txt`, stream)
    expect(await storage.getString(`${PREFIX}rt-stream.txt`)).toBe('streamed-s3')
  })

  test('get throws StorageNotFoundError for missing key', async () => {
    await expect(storage.get(`${PREFIX}missing.txt`)).rejects.toBeInstanceOf(StorageNotFoundError)
  })

  // ─── Content type round-trip ─────────────────────────────────────────────

  test('contentType rides on the stored object', async () => {
    await storage.put(`${PREFIX}ct.pdf`, new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      contentType: 'application/pdf',
    })
    const st = await storage.stat(`${PREFIX}ct.pdf`)
    expect(st.contentType).toBe('application/pdf')
  })

  // ─── Metadata ────────────────────────────────────────────────────────────

  test('exists returns true for a put object', async () => {
    await storage.put(`${PREFIX}exists.txt`, 'x')
    expect(await storage.exists(`${PREFIX}exists.txt`)).toBe(true)
  })

  test('exists returns false for missing key', async () => {
    expect(await storage.exists(`${PREFIX}never.txt`)).toBe(false)
  })

  test('stat returns size + lastModified + etag', async () => {
    await storage.put(`${PREFIX}stat.txt`, 'four')
    const st = await storage.stat(`${PREFIX}stat.txt`)
    expect(st.size).toBe(4)
    expect(st.lastModified).toBeInstanceOf(Date)
    expect(st.etag).toBeDefined()
  })

  test('stat throws StorageNotFoundError for missing key', async () => {
    await expect(storage.stat(`${PREFIX}absent.txt`)).rejects.toBeInstanceOf(StorageNotFoundError)
  })

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  test('delete returns true for existing key', async () => {
    await storage.put(`${PREFIX}del.txt`, 'x')
    expect(await storage.delete(`${PREFIX}del.txt`)).toBe(true)
    expect(await storage.exists(`${PREFIX}del.txt`)).toBe(false)
  })

  test('delete returns false for missing key', async () => {
    expect(await storage.delete(`${PREFIX}never.txt`)).toBe(false)
  })

  test('copy duplicates the object', async () => {
    await storage.put(`${PREFIX}copy-src.txt`, 'src-data-s3')
    await storage.copy(`${PREFIX}copy-src.txt`, `${PREFIX}copy/dst.txt`)
    expect(await storage.getString(`${PREFIX}copy/dst.txt`)).toBe('src-data-s3')
    expect(await storage.getString(`${PREFIX}copy-src.txt`)).toBe('src-data-s3')
  })

  test('copy throws StorageNotFoundError for missing source', async () => {
    await expect(storage.copy(`${PREFIX}no-src.txt`, `${PREFIX}no-dst.txt`)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    )
  })

  test('move via base copy+delete leaves source gone', async () => {
    await storage.put(`${PREFIX}move-src.txt`, 'moved-s3')
    await storage.move(`${PREFIX}move-src.txt`, `${PREFIX}moved/here.txt`)
    expect(await storage.exists(`${PREFIX}move-src.txt`)).toBe(false)
    expect(await storage.getString(`${PREFIX}moved/here.txt`)).toBe('moved-s3')
  })

  // ─── Listing ─────────────────────────────────────────────────────────────

  test('list returns objects under a prefix', async () => {
    const listPrefix = `${PREFIX}list/`
    await storage.put(`${listPrefix}a.txt`, '1')
    await storage.put(`${listPrefix}b.txt`, '2')
    await storage.put(`${listPrefix}sub/c.txt`, '3')

    const result = await storage.list({ prefix: listPrefix, recursive: true })
    const paths = result.entries.map((e) => e.path).filter((p) => p.startsWith(listPrefix))
    expect(paths).toContain(`${listPrefix}a.txt`)
    expect(paths).toContain(`${listPrefix}b.txt`)
    expect(paths).toContain(`${listPrefix}sub/c.txt`)
  })

  test('list surfaces common prefixes (subdirs) when not recursive', async () => {
    const listPrefix = `${PREFIX}list-d/`
    await storage.put(`${listPrefix}top.txt`, 'x')
    await storage.put(`${listPrefix}sub/inside.txt`, 'y')

    const result = await storage.list({ prefix: listPrefix, recursive: false })
    const dirs = result.entries.filter((e) => e.isDirectory).map((e) => e.path)
    expect(dirs).toContain(`${listPrefix}sub/`)
  })

  // ─── URLs ────────────────────────────────────────────────────────────────

  test('publicUrl returns the configured base joined with the key', async () => {
    const url = storage.publicUrl(`${PREFIX}public.txt`)
    expect(url).toContain(env.endpoint)
    expect(url).toContain(`${PREFIX}public.txt`)
  })

  test('publicUrl throws when publicBase is unset', () => {
    const noBase = new S3Storage({
      endpoint: env.endpoint,
      bucket: env.bucket,
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    })
    expect(() => noBase.publicUrl('a.txt')).toThrow(StorageDriverError)
  })

  test('signedUrl returns a fetchable presigned URL', async () => {
    await storage.put(`${PREFIX}signed.txt`, 'signed-content')
    const url = await storage.signedUrl(`${PREFIX}signed.txt`, { expiresIn: 60 })
    expect(url).toContain('http')
    expect(url).toContain('X-Amz-Signature')

    // The presigned URL should fetch back our content.
    const res = await fetch(url)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('signed-content')
  })

  // ─── Path safety ─────────────────────────────────────────────────────────

  test('rejects ../ traversal', async () => {
    await expect(storage.put('../escape.txt', 'x')).rejects.toBeInstanceOf(StoragePathError)
  })

  test('rejects absolute paths', async () => {
    await expect(storage.put('/abs.txt', 'x')).rejects.toBeInstanceOf(StoragePathError)
  })
})
