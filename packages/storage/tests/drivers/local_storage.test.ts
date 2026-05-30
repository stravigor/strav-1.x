import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LocalStorage,
  StorageDriverError,
  StorageNotFoundError,
  StoragePathError,
} from '../../src/index.ts'

let root: string
let storage: LocalStorage

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'strav-storage-local-'))
  storage = new LocalStorage({ root, publicBase: 'http://localhost:3000/files' })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('LocalStorage — put / get', () => {
  test('round-trips a string', async () => {
    await storage.put('rt/a.txt', 'hello')
    expect(await storage.getString('rt/a.txt')).toBe('hello')
  })

  test('round-trips Uint8Array bytes', async () => {
    await storage.put('rt/bytes.bin', new Uint8Array([1, 2, 3, 4]))
    const bytes = await storage.get('rt/bytes.bin')
    expect([...bytes]).toEqual([1, 2, 3, 4])
  })

  test('round-trips a Blob', async () => {
    await storage.put('rt/blob.txt', new Blob(['blob-content']))
    expect(await storage.getString('rt/blob.txt')).toBe('blob-content')
  })

  test('round-trips a ReadableStream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed-'))
        controller.enqueue(new TextEncoder().encode('content'))
        controller.close()
      },
    })
    await storage.put('rt/stream.txt', stream)
    expect(await storage.getString('rt/stream.txt')).toBe('streamed-content')
  })

  test('creates parent directories on demand', async () => {
    await storage.put('deep/nested/path/file.txt', 'ok')
    expect(await storage.getString('deep/nested/path/file.txt')).toBe('ok')
  })

  test('overwrites existing files', async () => {
    await storage.put('over/a.txt', 'first')
    await storage.put('over/a.txt', 'second')
    expect(await storage.getString('over/a.txt')).toBe('second')
  })

  test('get throws StorageNotFoundError for missing key', async () => {
    await expect(storage.get('missing/file.txt')).rejects.toBeInstanceOf(StorageNotFoundError)
  })

  test('getString throws StorageNotFoundError for missing key', async () => {
    await expect(storage.getString('missing/file.txt')).rejects.toBeInstanceOf(StorageNotFoundError)
  })

  test('getStream emits the file contents', async () => {
    await storage.put('stream/out.txt', 'streamed')
    const reader = (await storage.getStream('stream/out.txt')).getReader()
    let collected = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value !== undefined) collected += new TextDecoder().decode(value)
    }
    expect(collected).toBe('streamed')
  })
})

describe('LocalStorage — metadata', () => {
  test('exists returns true for a put file', async () => {
    await storage.put('meta/exists.txt', 'x')
    expect(await storage.exists('meta/exists.txt')).toBe(true)
  })

  test('exists returns false for missing key', async () => {
    expect(await storage.exists('meta/absent.txt')).toBe(false)
  })

  test('stat returns size + lastModified', async () => {
    await storage.put('meta/stat.txt', 'four')
    const st = await storage.stat('meta/stat.txt')
    expect(st.size).toBe(4)
    expect(st.lastModified).toBeInstanceOf(Date)
  })

  test('stat throws StorageNotFoundError for missing key', async () => {
    await expect(storage.stat('meta/absent.txt')).rejects.toBeInstanceOf(StorageNotFoundError)
  })
})

describe('LocalStorage — lifecycle', () => {
  test('delete returns true for existing key', async () => {
    await storage.put('lc/del.txt', 'x')
    expect(await storage.delete('lc/del.txt')).toBe(true)
    expect(await storage.exists('lc/del.txt')).toBe(false)
  })

  test('delete returns false for missing key', async () => {
    expect(await storage.delete('lc/never.txt')).toBe(false)
  })

  test('copy duplicates the file', async () => {
    await storage.put('lc/src.txt', 'src-data')
    await storage.copy('lc/src.txt', 'lc/copy/dst.txt')
    expect(await storage.getString('lc/copy/dst.txt')).toBe('src-data')
    expect(await storage.getString('lc/src.txt')).toBe('src-data')
  })

  test('copy throws StorageNotFoundError for missing source', async () => {
    await expect(storage.copy('lc/missing.txt', 'lc/copy/elsewhere.txt')).rejects.toBeInstanceOf(
      StorageNotFoundError,
    )
  })

  test('move via rename leaves source gone', async () => {
    await storage.put('lc/move-src.txt', 'moved')
    await storage.move('lc/move-src.txt', 'lc/moved/here.txt')
    expect(await storage.exists('lc/move-src.txt')).toBe(false)
    expect(await storage.getString('lc/moved/here.txt')).toBe('moved')
  })

  test('move throws StorageNotFoundError for missing source', async () => {
    await expect(storage.move('lc/no-src.txt', 'lc/no-dst.txt')).rejects.toBeInstanceOf(
      StorageNotFoundError,
    )
  })
})

describe('LocalStorage — list', () => {
  beforeAll(async () => {
    // Seed a deterministic tree.
    await storage.put('list/a.txt', '1')
    await storage.put('list/b.txt', '22')
    await storage.put('list/c.txt', '333')
    await storage.put('list/sub/d.txt', '4444')
    await storage.put('list/sub/e.txt', '55555')
  })

  test('lists direct children when not recursive', async () => {
    const result = await storage.list({ prefix: 'list/' })
    const paths = result.entries.map((e) => e.path)
    expect(paths).toContain('list/a.txt')
    expect(paths).toContain('list/b.txt')
    expect(paths).toContain('list/c.txt')
    expect(paths).toContain('list/sub')
    // The `sub/` directory entry should be flagged.
    const sub = result.entries.find((e) => e.path === 'list/sub')
    expect(sub?.isDirectory).toBe(true)
    // And we should NOT see grandchildren when not recursive.
    expect(paths).not.toContain('list/sub/d.txt')
  })

  test('recurses into subdirectories when recursive: true', async () => {
    const result = await storage.list({ prefix: 'list/', recursive: true })
    const paths = result.entries.map((e) => e.path)
    expect(paths).toContain('list/sub/d.txt')
    expect(paths).toContain('list/sub/e.txt')
  })

  test('paginates via cursor', async () => {
    const first = await storage.list({ prefix: 'list/', recursive: true, limit: 2 })
    expect(first.entries).toHaveLength(2)
    expect(first.cursor).toBeDefined()

    const second = await storage.list({
      prefix: 'list/',
      recursive: true,
      limit: 2,
      after: first.cursor,
    })
    // Combined coverage should hit the rest of the seeded tree.
    const allPaths = [...first.entries, ...second.entries].map((e) => e.path)
    expect(new Set(allPaths).size).toBe(allPaths.length) // no dupes across pages
  })

  test('returns empty result for unmatched prefix', async () => {
    const result = await storage.list({ prefix: 'no-such-thing/' })
    expect(result.entries).toEqual([])
    expect(result.cursor).toBeUndefined()
  })
})

describe('LocalStorage — URLs', () => {
  test('publicUrl returns the configured base joined with the key', async () => {
    expect(storage.publicUrl('reports/q1.pdf')).toBe('http://localhost:3000/files/reports/q1.pdf')
  })

  test('publicUrl throws when publicBase is unset', () => {
    const noBase = new LocalStorage({ root })
    expect(() => noBase.publicUrl('a.txt')).toThrow(StorageDriverError)
  })

  test('signedUrl throws — local storage has no signing authority', async () => {
    await expect(storage.signedUrl('a.txt', { expiresIn: 60 })).rejects.toBeInstanceOf(
      StorageDriverError,
    )
  })
})

describe('LocalStorage — path safety', () => {
  test('rejects ../ traversal in put', async () => {
    await expect(storage.put('../escape.txt', 'x')).rejects.toBeInstanceOf(StoragePathError)
  })

  test('rejects absolute paths in put', async () => {
    await expect(storage.put('/absolute.txt', 'x')).rejects.toBeInstanceOf(StoragePathError)
  })

  test('rejects backslashes in put', async () => {
    await expect(storage.put('win\\path.txt', 'x')).rejects.toBeInstanceOf(StoragePathError)
  })

  test('rejects empty path', async () => {
    await expect(storage.put('', 'x')).rejects.toBeInstanceOf(StoragePathError)
  })
})
