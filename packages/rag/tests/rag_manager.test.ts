/**
 * RagManager tests — wire through with stubbed BrainManager and
 * MemoryDriver, verify the manager threads options correctly,
 * applies prefix/defaults, and propagates embedding failures as
 * EmbeddingError.
 */

import { describe, expect, test } from 'bun:test'
import { BrainManager } from '@strav/brain'
import { MemoryDriver } from '../src/drivers/memory_driver.ts'
import { EmbeddingError, RagError } from '../src/rag_error.ts'
import { RagManager } from '../src/rag_manager.ts'
import type { RagConfig } from '../src/types.ts'

/** Make a BrainManager whose embed() returns deterministic vectors. */
function brainStub(opts: {
  embed?: (texts: readonly string[], options?: unknown) => Promise<number[][]>
  embedThrows?: Error
}): BrainManager {
  const stub = {
    embed: async (texts: readonly string[]) => {
      if (opts.embedThrows) throw opts.embedThrows
      const embeddings = opts.embed
        ? await opts.embed(texts)
        : texts.map((_, i) => [1 - i * 0.01, i * 0.01]) // each call slightly distinct
      return {
        embeddings,
        model: 'stub',
        usage: { inputTokens: 0 },
        raw: null,
      }
    },
  }
  return stub as unknown as BrainManager
}

const baseConfig: RagConfig = {
  default: 'mem',
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 2 },
  chunking: { strategy: 'recursive', chunkSize: 16, overlap: 0 },
  stores: { mem: { driver: 'memory' } },
}

describe('RagManager — construction', () => {
  test('throws when default store is not in stores', () => {
    expect(
      () =>
        new RagManager({
          config: { ...baseConfig, default: 'missing' },
          brain: brainStub({}),
        }),
    ).toThrow(RagError)
  })

  test('store(name) memoizes the constructed store', () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    const a = m.store()
    const b = m.store('mem')
    expect(a).toBe(b)
  })

  test('store(unknown) throws', () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    expect(() => m.store('nope')).toThrow(RagError)
  })

  test('extend registers a custom driver factory', async () => {
    const m = new RagManager({
      config: {
        ...baseConfig,
        default: 'custom',
        stores: { custom: { driver: 'custom' } },
      },
      brain: brainStub({}),
    })
    const driver = new MemoryDriver()
    m.extend('custom', () => driver)
    expect(m.store('custom')).toBe(driver)
  })

  test('pgvector driver without a db throws on resolve', () => {
    const m = new RagManager({
      config: {
        ...baseConfig,
        default: 'pg',
        stores: { pg: { driver: 'pgvector' } },
      },
      brain: brainStub({}),
    })
    expect(() => m.store()).toThrow(/PostgresDatabase/)
  })

  test('unknown driver throws on resolve', () => {
    const m = new RagManager({
      config: {
        ...baseConfig,
        default: 'huh',
        stores: { huh: { driver: 'huh' } },
      },
      brain: brainStub({}),
    })
    expect(() => m.store()).toThrow(/unknown driver/i)
  })
})

describe('RagManager — collectionName', () => {
  test('applies prefix when configured', () => {
    const m = new RagManager({
      config: { ...baseConfig, prefix: 'app_' },
      brain: brainStub({}),
    })
    expect(m.collectionName('articles')).toBe('app_articles')
  })

  test('no-op when prefix is empty', () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    expect(m.collectionName('articles')).toBe('articles')
  })
})

describe('RagManager — ingest', () => {
  test('chunks → embeds → upserts with metadata + offsets', async () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    await m.createCollection('articles')
    const ids = await m.ingest('articles', 'first chunk text\n\nsecond chunk', {
      sourceId: 'doc_1',
      metadata: { author: 'liva' },
    })
    expect(ids.length).toBeGreaterThan(0)

    // Query back the first chunk's vector to find it.
    const result = await m.store().query('articles', [1, 0], { topK: 5 })
    expect(result.matches.length).toBeGreaterThan(0)
    const first = result.matches[0]!
    expect(first.sourceId).toBe('doc_1')
    expect(first.metadata.author).toBe('liva')
    expect(first.metadata.chunkIndex).toBe(0)
  })

  test('empty content → empty id list', async () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    await m.createCollection('articles')
    expect(await m.ingest('articles', '')).toEqual([])
  })

  test('sanitize hook can drop chunks (return null) and rewrite content', async () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    await m.createCollection('articles')
    const ids = await m.ingest('articles', 'keep one.\n\ndrop two.\n\nrewrite three.', {
      sanitize: ({ content }) => {
        if (content.includes('drop')) return null
        if (content.includes('rewrite')) return '[REDACTED]'
        return content
      },
    })
    expect(ids).toHaveLength(2)
    const result = await m.store().query('articles', [1, 0], { topK: 5 })
    const contents = result.matches.map((m) => m.content)
    expect(contents).not.toContain('drop two.')
    expect(contents.some((c) => c.includes('[REDACTED]'))).toBe(true)
  })

  test('chunks: pre-chunked bypasses the chunker', async () => {
    const m = new RagManager({ config: baseConfig, brain: brainStub({}) })
    await m.createCollection('articles')
    const ids = await m.ingest('articles', 'unused', {
      chunks: [
        { content: 'a', index: 0, startOffset: 0, endOffset: 1 },
        { content: 'b', index: 1, startOffset: 1, endOffset: 2 },
      ],
    })
    expect(ids).toHaveLength(2)
  })

  test('embedding errors wrap into EmbeddingError', async () => {
    const m = new RagManager({
      config: baseConfig,
      brain: brainStub({ embedThrows: new Error('rate limited') }),
    })
    await m.createCollection('articles')
    await expect(m.ingest('articles', 'content')).rejects.toBeInstanceOf(EmbeddingError)
  })

  test('applies prefix to the upsert collection', async () => {
    const m = new RagManager({
      config: { ...baseConfig, prefix: 'tenant42_' },
      brain: brainStub({}),
    })
    await m.createCollection('articles')
    await m.ingest('articles', 'hello')
    // Query against the raw store with the prefixed collection to confirm.
    const result = await m.store().query('tenant42_articles', [1, 0], { topK: 1 })
    expect(result.matches).toHaveLength(1)
  })
})

describe('RagManager — retrieve', () => {
  test('embeds query → queries store → returns ranked matches', async () => {
    const m = new RagManager({
      config: baseConfig,
      brain: brainStub({
        embed: async (texts) =>
          texts.map((t) => (t === 'query' ? [1, 0] : [0.9, 0.1])),
      }),
    })
    await m.createCollection('articles')
    await m.store().upsert('articles', [
      { id: '1', content: 'first', embedding: [1, 0], metadata: { kind: 'doc' } },
      { id: '2', content: 'second', embedding: [-1, 0], metadata: { kind: 'doc' } },
    ])
    const r = await m.retrieve('query', { collection: 'articles' })
    expect(r.query).toBe('query')
    expect(r.matches[0]?.id).toBe('1')
    expect(r.matches[0]?.similarity).toBe(r.matches[0]?.score)
  })

  test('topK / threshold / filter pass through', async () => {
    const m = new RagManager({
      config: baseConfig,
      brain: brainStub({ embed: async (texts) => texts.map(() => [1, 0]) }),
    })
    await m.createCollection('articles')
    await m.store().upsert('articles', [
      { id: 'a', content: 'a', embedding: [1, 0], metadata: { kind: 'doc' } },
      { id: 'b', content: 'b', embedding: [1, 0], metadata: { kind: 'note' } },
    ])
    const r = await m.retrieve('q', {
      collection: 'articles',
      topK: 1,
      filter: { kind: 'note' },
    })
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]?.id).toBe('b')
  })

  test('embedding error during retrieve wraps as EmbeddingError', async () => {
    const m = new RagManager({
      config: baseConfig,
      brain: brainStub({ embedThrows: new Error('boom') }),
    })
    await m.createCollection('articles')
    await expect(m.retrieve('q', { collection: 'articles' })).rejects.toBeInstanceOf(
      EmbeddingError,
    )
  })
})
