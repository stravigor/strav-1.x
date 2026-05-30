/**
 * Reranker tests — KeywordReranker (lexical blend) + MMRReranker
 * (diversity) + RagManager integration (rerankPool + topK slicing).
 */

import { describe, expect, test } from 'bun:test'
import type { BrainManager } from '@strav/brain'
import type { MemoryDriver } from '../src/drivers/memory/memory_driver.ts'
import { RagManager } from '../src/rag_manager.ts'
import { KeywordReranker, MMRReranker, type Reranker } from '../src/rerankers/index.ts'
import type { RagConfig, RetrievedDocument } from '../src/types.ts'

function docs(
  rows: Array<{
    id: string
    content: string
    similarity: number
    metadata?: Record<string, unknown>
  }>,
): RetrievedDocument[] {
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    score: r.similarity,
    similarity: r.similarity,
    metadata: r.metadata ?? {},
  }))
}

describe('KeywordReranker', () => {
  test('boosts matches that contain query tokens', async () => {
    const rer = new KeywordReranker({ weight: 0.5 })
    const result = await rer.rerank(
      'invoice payment',
      docs([
        { id: 'a', content: 'unrelated content about cats', similarity: 0.9 },
        { id: 'b', content: 'invoice payment receipt', similarity: 0.7 },
        { id: 'c', content: 'payment terms', similarity: 0.6 },
      ]),
    )
    // b matches both tokens (full boost) → wins over the higher-similarity a.
    expect(result[0]?.id).toBe('b')
    expect(result[0]?.similarity).toBe(0.7)
    expect(result[0]?.score).toBeGreaterThan(0.7)
  })

  test('weight 0 collapses to similarity order', async () => {
    const rer = new KeywordReranker({ weight: 0 })
    const result = await rer.rerank(
      'invoice',
      docs([
        { id: 'a', content: 'unrelated', similarity: 0.9 },
        { id: 'b', content: 'invoice', similarity: 0.5 },
      ]),
    )
    expect(result.map((m) => m.id)).toEqual(['a', 'b'])
  })

  test('caseSensitive option respected', async () => {
    const insensitive = new KeywordReranker({ weight: 0.5 })
    const sensitive = new KeywordReranker({ weight: 0.5, caseSensitive: true })
    const matches = docs([
      { id: 'a', content: 'Invoice Receipt', similarity: 0.4 },
      { id: 'b', content: 'unrelated', similarity: 0.5 },
    ])
    // Insensitive: 'invoice' hits 'Invoice' → a boosted past b.
    expect((await insensitive.rerank('invoice', matches))[0]?.id).toBe('a')
    // Sensitive: 'invoice' misses 'Invoice' → nothing boosted, b's
    // raw similarity wins.
    expect((await sensitive.rerank('invoice', matches))[0]?.id).toBe('b')
  })

  test('empty query passes through unchanged', async () => {
    const rer = new KeywordReranker({ weight: 0.5 })
    const input = docs([
      { id: 'a', content: 'x', similarity: 0.9 },
      { id: 'b', content: 'y', similarity: 0.7 },
    ])
    const result = await rer.rerank('', input)
    expect(result.map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('MMRReranker', () => {
  test('penalizes near-duplicates', async () => {
    // Two near-duplicates (a, a') both close to query; a third diverse doc.
    const embeddings = new Map<string, number[]>([
      ['query', [1, 0]],
      ['a', [0.95, 0.05]],
      ['a2', [0.94, 0.06]],
      ['b', [0.4, 0.9]],
    ])
    const rer = new MMRReranker({
      lambda: 0.3, // diversity-leaning blend
      embed: async (t) => embeddings.get(t) ?? [0, 0],
    })
    const result = await rer.rerank(
      'query',
      docs([
        { id: 'a', content: 'a', similarity: 0.95 },
        { id: 'a2', content: 'a2', similarity: 0.94 },
        { id: 'b', content: 'b', similarity: 0.6 },
      ]),
    )
    // First pick = highest relevance = a. Second pick: with lambda
    // tilted toward diversity, b beats the near-duplicate a2.
    expect(result[0]?.id).toBe('a')
    expect(result[1]?.id).toBe('b')
    expect(result[2]?.id).toBe('a2')
  })

  test('lambda=1 collapses to pure relevance', async () => {
    const embeddings = new Map<string, number[]>([
      ['query', [1, 0]],
      ['a', [0.95, 0.05]],
      ['a2', [0.94, 0.06]],
      ['b', [0.4, 0.9]],
    ])
    const rer = new MMRReranker({
      lambda: 1,
      embed: async (t) => embeddings.get(t) ?? [0, 0],
    })
    const result = await rer.rerank(
      'query',
      docs([
        { id: 'b', content: 'b', similarity: 0.6 },
        { id: 'a', content: 'a', similarity: 0.95 },
        { id: 'a2', content: 'a2', similarity: 0.94 },
      ]),
    )
    expect(result.map((m) => m.id)).toEqual(['a', 'a2', 'b'])
  })

  test('single-match input returns unchanged', async () => {
    const rer = new MMRReranker({ embed: async () => [1, 0] })
    const result = await rer.rerank('q', docs([{ id: 'a', content: 'a', similarity: 0.9 }]))
    expect(result.map((m) => m.id)).toEqual(['a'])
  })
})

// ─── RagManager integration ──────────────────────────────────────────────

const baseConfig: RagConfig = {
  default: 'mem',
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 2 },
  chunking: { strategy: 'recursive', chunkSize: 64, overlap: 0 },
  stores: { mem: { driver: 'memory' } },
}

function brainStub(): BrainManager {
  return {
    embed: async (texts: readonly string[]) => ({
      embeddings: texts.map(() => [1, 0]),
      model: 'stub',
      usage: { inputTokens: 0 },
      raw: null,
    }),
  } as unknown as BrainManager
}

describe('RagManager.retrieve — rerank integration', () => {
  test('rerankPool widens fetch then topK truncates after reorder', async () => {
    const manager = new RagManager({ config: baseConfig, brain: brainStub() })
    const store = manager.store() as MemoryDriver
    await store.createCollection('articles', 2)
    await store.upsert('articles', [
      { id: 'v1', content: 'unrelated cats', embedding: [1, 0], metadata: {} },
      { id: 'v2', content: 'unrelated dogs', embedding: [0.99, 0.01], metadata: {} },
      { id: 'v3', content: 'invoice payment receipt', embedding: [0.95, 0.05], metadata: {} },
      { id: 'v4', content: 'order confirmation', embedding: [0.9, 0.1], metadata: {} },
    ])

    // Without rerank: just top 2 by similarity (v1, v2).
    const plain = await manager.retrieve('invoice payment', {
      collection: 'articles',
      topK: 2,
    })
    expect(plain.matches.map((m) => m.id)).toEqual(['v1', 'v2'])

    // With KeywordReranker + pool=4: v3 (matches both tokens) wins
    // even though its raw similarity is lower than v1/v2.
    const ranked = await manager.retrieve('invoice payment', {
      collection: 'articles',
      topK: 2,
      rerankPool: 4,
      rerank: new KeywordReranker({ weight: 0.5 }),
    })
    expect(ranked.matches[0]?.id).toBe('v3')
    expect(ranked.matches).toHaveLength(2)
    // similarity field is carried verbatim from the vector store;
    // the reranker only touches `score`.
    expect(ranked.matches[0]?.score).not.toBe(ranked.matches[0]?.similarity)
  })

  test('rerankPool defaults to topK when unset', async () => {
    let observedTopK: number | undefined
    const probe: Reranker = {
      rerank(_query, matches) {
        observedTopK = matches.length
        return [...matches]
      },
    }
    const manager = new RagManager({ config: baseConfig, brain: brainStub() })
    const store = manager.store() as MemoryDriver
    await store.createCollection('articles', 2)
    await store.upsert('articles', [
      { id: 'a', content: 'a', embedding: [1, 0], metadata: {} },
      { id: 'b', content: 'b', embedding: [0.9, 0.1], metadata: {} },
      { id: 'c', content: 'c', embedding: [0.8, 0.2], metadata: {} },
    ])
    await manager.retrieve('q', { collection: 'articles', topK: 2, rerank: probe })
    expect(observedTopK).toBe(2)
  })
})
