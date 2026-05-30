/**
 * `retrievable()` mixin tests. We mix it onto a stub Repository
 * so the test doesn't need PostgresDatabase; the mixin's
 * collaboration with `RagManager` (via MemoryDriver) is the real
 * thing.
 */

import { describe, expect, test } from 'bun:test'
import type { BrainManager } from '@strav/brain'
import type { Repository } from '@strav/database'
import { MemoryDriver } from '../src/drivers/memory/memory_driver.ts'
import { RagManager } from '../src/rag_manager.ts'
import { retrievable } from '../src/retrievable.ts'
import type { RagConfig } from '../src/types.ts'

// ─── Test fixtures ───────────────────────────────────────────────────────

interface Article {
  id: string
  title: string
  body: string
  draft?: boolean
  author_id?: string
}

const articleSchema = { name: 'article' } as const

/**
 * A bare-minimum "Repository" stand-in that the mixin extends.
 * We pass it as the Base — the mixin only relies on `query()`,
 * `findMany(...)`, and the static `schema` field for V1.
 *
 * In real apps the Base is `Repository<Article>` from
 * `@strav/database`. Here we stub just enough surface for the
 * methods the mixin actually invokes.
 */
class StubArticleRepo {
  static schema = articleSchema
  static model = class {}

  rows: Article[] = []

  query() {
    let _orderBy: string | undefined
    let _limit: number | undefined
    let _offset = 0
    const self = this
    const builder = {
      orderBy(_col: string, _dir: 'asc' | 'desc') {
        _orderBy = _col
        return this
      },
      limit(n: number) {
        _limit = n
        return this
      },
      offset(n: number) {
        _offset = n
        return this
      },
      async get(): Promise<Article[]> {
        const sorted = [...self.rows].sort((a, b) => a.id.localeCompare(b.id))
        return sorted.slice(_offset, _limit !== undefined ? _offset + _limit : undefined)
      },
    }
    return builder
  }

  async findMany(ids: readonly string[]): Promise<Article[]> {
    const set = new Set(ids)
    return this.rows.filter((r) => set.has(r.id))
  }
}

/**
 * Cast the stub to `Repository<Article>` constructor — the mixin's
 * generic bound is satisfied structurally at runtime (the stub has
 * `query`, `findMany`, `static schema`), but TS demands the
 * declared type for compile-time. Tests-only cast.
 */
// biome-ignore lint/suspicious/noExplicitAny: see comment above.
const StubAsRepoCtor = StubArticleRepo as unknown as new (
  ...args: any[]
) => Repository<Article> & StubArticleRepo

/** Build a RagManager with a stub BrainManager + MemoryDriver pre-attached. */
function makeRag(): RagManager {
  const config: RagConfig = {
    default: 'mem',
    embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 2 },
    chunking: { strategy: 'fixed', chunkSize: 1024, overlap: 0 },
    stores: { mem: { driver: 'memory' } },
  }
  const brain = {
    embed: async (texts: readonly string[]) => ({
      embeddings: texts.map((_, i) => [1 - i * 0.01, i * 0.01]),
      model: 'stub',
      usage: { inputTokens: 0 },
      raw: null,
    }),
  } as unknown as BrainManager
  return new RagManager({ config, brain })
}

class ArticleRepository extends retrievable<Article, typeof StubAsRepoCtor>(StubAsRepoCtor) {
  static schema = articleSchema
  static model = StubArticleRepo.model

  constructor(rag: RagManager) {
    super()
    this.rag = rag
  }
}

// ─── Default behavior ────────────────────────────────────────────────────

describe('retrievable() — defaults', () => {
  test('collectionName defaults to the schema name', () => {
    const rag = makeRag()
    const repo = new ArticleRepository(rag)
    expect((repo as unknown as { collectionName(): string }).collectionName()).toBe('article')
  })

  test('toContent defaults to concatenating string fields', () => {
    const repo = new ArticleRepository(makeRag())
    const text = (repo as unknown as { toContent(a: Article): string }).toContent({
      id: 'a_1',
      title: 'Title',
      body: 'Body',
    })
    expect(text).toContain('Title')
    expect(text).toContain('Body')
  })

  test('shouldRetrieve defaults to true', () => {
    const repo = new ArticleRepository(makeRag())
    expect(
      (repo as unknown as { shouldRetrieve(_: Article): boolean }).shouldRetrieve({
        id: 'a_1',
        title: 't',
        body: 'b',
      }),
    ).toBe(true)
  })
})

// ─── vectorize / vectorRemove ───────────────────────────────────────────

describe('retrievable() — vectorize', () => {
  test('indexes content under the collection with sourceId = model.id', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    const ids = await repo.vectorize({ id: 'a_1', title: 'Hello', body: 'World' })
    expect(ids.length).toBeGreaterThan(0)
    const { matches } = await rag.store().query('article', [1, 0], { topK: 5 })
    expect(matches[0]?.sourceId).toBe('a_1')
    expect(matches[0]?.content).toContain('Hello')
  })

  test('re-vectorize on the same id drops the previous chunks', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    await repo.vectorize({ id: 'a_1', title: 'first', body: 'version' })
    await repo.vectorize({ id: 'a_1', title: 'second', body: 'version' })
    const { matches } = await rag.store().query('article', [1, 0], { topK: 10 })
    // Only the second version's chunks should remain.
    expect(matches.every((m) => m.sourceId === 'a_1')).toBe(true)
    expect(matches.every((m) => m.content.includes('second'))).toBe(true)
  })

  test('shouldRetrieve = false drops chunks without re-ingest', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    class DraftAware extends retrievable<Article, typeof StubAsRepoCtor>(StubAsRepoCtor) {
      static schema = articleSchema
      static model = StubArticleRepo.model
      constructor(rag: RagManager) {
        super()
        this.rag = rag
      }
      override shouldRetrieve(a: Article): boolean {
        return a.draft !== true
      }
    }
    const repo = new DraftAware(rag)
    // Index first.
    await repo.vectorize({ id: 'a_1', title: 'published', body: 'live' })
    let result = await rag.store().query('article', [1, 0], { topK: 5 })
    expect(result.matches).toHaveLength(1)
    // Mark draft → should drop the chunks.
    await repo.vectorize({ id: 'a_1', title: 'now draft', body: 'wip', draft: true })
    result = await rag.store().query('article', [1, 0], { topK: 5 })
    expect(result.matches).toHaveLength(0)
  })

  test('empty content → empty id list (no embedding call)', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    class EmptyContent extends retrievable<Article, typeof StubAsRepoCtor>(StubAsRepoCtor) {
      static schema = articleSchema
      static model = StubArticleRepo.model
      constructor(rag: RagManager) {
        super()
        this.rag = rag
      }
      override toContent(_a: Article): string {
        return ''
      }
    }
    const repo = new EmptyContent(rag)
    const ids = await repo.vectorize({ id: 'a_1', title: 't', body: 'b' })
    expect(ids).toEqual([])
  })

  test('vectorRemove drops every chunk for the id', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    await repo.vectorize({ id: 'a_1', title: 'x', body: 'y' })
    await repo.vectorRemove({ id: 'a_1', title: 'x', body: 'y' })
    const { matches } = await rag.store().query('article', [1, 0], { topK: 5 })
    expect(matches).toEqual([])
  })

  test('model without id throws a clear error', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    await expect(repo.vectorize({ title: 't', body: 'b' } as unknown as Article)).rejects.toThrow(
      /no `id`/,
    )
  })
})

// ─── retrieve ───────────────────────────────────────────────────────────

describe('retrievable() — retrieve', () => {
  test('defaults the collection to collectionName()', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    await repo.vectorize({ id: 'a_1', title: 'matched', body: 'content' })
    const { matches } = await repo.retrieve('query')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.sourceId).toBe('a_1')
  })

  test('explicit collection overrides', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    await rag.createCollection('other')
    const repo = new ArticleRepository(rag)
    await repo.vectorize({ id: 'a_1', title: 'in article', body: '' })
    const { matches } = await repo.retrieve('q', { collection: 'other' })
    expect(matches).toEqual([])
  })
})

// ─── resolveMatches ─────────────────────────────────────────────────────

describe('retrievable() — resolveMatches', () => {
  test('hydrates source rows in match order, drops deleted', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    repo.rows = [
      { id: 'a_1', title: 'Article One', body: 'a' },
      { id: 'a_2', title: 'Article Two', body: 'b' },
    ]
    await repo.vectorize(repo.rows[0]!)
    await repo.vectorize(repo.rows[1]!)
    // Drop a_2 from the source rows to simulate a delete-between-index-and-retrieve.
    repo.rows = repo.rows.filter((r) => r.id !== 'a_2')
    const { matches } = await repo.retrieve('q')
    const rows = await repo.resolveMatches(matches)
    expect(rows.map((r) => r.id)).toEqual(['a_1'])
  })
})

// ─── reindexAll ─────────────────────────────────────────────────────────

describe('retrievable() — reindexAll', () => {
  test('walks every row in batches and vectorizes each', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    repo.rows = Array.from({ length: 7 }, (_, i) => ({
      id: `a_${i}`,
      title: `Title ${i}`,
      body: `Body ${i}`,
    }))
    const processed = await repo.reindexAll(3)
    expect(processed).toBe(7)
    const { matches } = await rag.store().query('article', [1, 0], { topK: 50 })
    const sourceIds = new Set(matches.map((m) => m.sourceId))
    expect(sourceIds.size).toBe(7)
  })

  test('empty repo → 0 processed', async () => {
    const rag = makeRag()
    await rag.createCollection('article')
    const repo = new ArticleRepository(rag)
    expect(await repo.reindexAll()).toBe(0)
  })
})
