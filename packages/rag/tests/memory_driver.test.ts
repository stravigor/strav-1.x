/**
 * MemoryDriver tests — exercise the full VectorStore contract
 * against the in-process driver. Cosine similarity is verified
 * directly against hand-computed vectors so the scoring contract
 * is testable without floating-point fuzz.
 */

import { describe, expect, test } from 'bun:test'
import { MemoryDriver } from '../src/drivers/memory_driver.ts'
import { CollectionNotFoundError } from '../src/rag_error.ts'

const driver = () => new MemoryDriver()

describe('MemoryDriver — collections', () => {
  test('upsert / query against a missing collection throws CollectionNotFoundError', async () => {
    const d = driver()
    await expect(d.upsert('articles', [])).rejects.toBeInstanceOf(CollectionNotFoundError)
    await expect(d.query('articles', [1, 0])).rejects.toBeInstanceOf(CollectionNotFoundError)
  })

  test('createCollection is idempotent', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.createCollection('a', 2)
    await d.upsert('a', [{ id: '1', content: 'x', embedding: [1, 0], metadata: {} }])
    // Second createCollection didn't wipe the bucket.
    const r = await d.query('a', [1, 0])
    expect(r.matches).toHaveLength(1)
  })

  test('deleteCollection removes everything', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [{ id: '1', content: 'x', embedding: [1, 0], metadata: {} }])
    await d.deleteCollection('a')
    await expect(d.query('a', [1, 0])).rejects.toBeInstanceOf(CollectionNotFoundError)
  })
})

describe('MemoryDriver — query semantics', () => {
  test('cosine similarity: identical vectors score 1', async () => {
    const d = driver()
    await d.createCollection('a', 3)
    await d.upsert('a', [
      { id: '1', content: 'identical', embedding: [1, 0, 0], metadata: {} },
    ])
    const r = await d.query('a', [1, 0, 0])
    expect(r.matches[0]?.score).toBeCloseTo(1, 5)
  })

  test('cosine similarity: orthogonal vectors score 0.5', async () => {
    // Cosine of orthogonal vectors is 0; we map [-1, 1] → [0, 1]
    // so 0 → 0.5.
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: '1', content: 'orthogonal', embedding: [1, 0], metadata: {} },
    ])
    const r = await d.query('a', [0, 1])
    expect(r.matches[0]?.score).toBeCloseTo(0.5, 5)
  })

  test('ranks by similarity descending', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: 'far', content: 'far', embedding: [-1, 0], metadata: {} },
      { id: 'mid', content: 'mid', embedding: [0, 1], metadata: {} },
      { id: 'near', content: 'near', embedding: [0.99, 0.14], metadata: {} },
    ])
    const r = await d.query('a', [1, 0])
    expect(r.matches.map((m) => m.id)).toEqual(['near', 'mid', 'far'])
  })

  test('topK truncates', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: '1', content: 'a', embedding: [1, 0], metadata: {} },
      { id: '2', content: 'b', embedding: [0.9, 0.1], metadata: {} },
      { id: '3', content: 'c', embedding: [0.5, 0.5], metadata: {} },
    ])
    const r = await d.query('a', [1, 0], { topK: 2 })
    expect(r.matches).toHaveLength(2)
  })

  test('threshold filters out low scores', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: 'high', content: 'h', embedding: [1, 0], metadata: {} },
      { id: 'low', content: 'l', embedding: [-1, 0], metadata: {} }, // score 0 after mapping
    ])
    const r = await d.query('a', [1, 0], { threshold: 0.4 })
    expect(r.matches.map((m) => m.id)).toEqual(['high'])
  })

  test('flat AND filter on metadata', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: '1', content: 'a', embedding: [1, 0], metadata: { lang: 'en', kind: 'doc' } },
      { id: '2', content: 'b', embedding: [1, 0], metadata: { lang: 'fr', kind: 'doc' } },
      { id: '3', content: 'c', embedding: [1, 0], metadata: { lang: 'en', kind: 'note' } },
    ])
    const r = await d.query('a', [1, 0], { filter: { lang: 'en', kind: 'doc' } })
    expect(r.matches.map((m) => m.id)).toEqual(['1'])
  })
})

describe('MemoryDriver — mutations', () => {
  test('upsert by id overwrites', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [{ id: '1', content: 'first', embedding: [1, 0], metadata: {} }])
    await d.upsert('a', [{ id: '1', content: 'second', embedding: [1, 0], metadata: {} }])
    const r = await d.query('a', [1, 0])
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]?.content).toBe('second')
  })

  test('delete by ids removes only those', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: '1', content: 'a', embedding: [1, 0], metadata: {} },
      { id: '2', content: 'b', embedding: [1, 0], metadata: {} },
    ])
    await d.delete('a', ['1'])
    const r = await d.query('a', [1, 0])
    expect(r.matches.map((m) => m.id)).toEqual(['2'])
  })

  test('deleteBySource drops every chunk from one source', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [
      { id: '1', sourceId: 'doc_1', content: 'a', embedding: [1, 0], metadata: {} },
      { id: '2', sourceId: 'doc_1', content: 'b', embedding: [1, 0], metadata: {} },
      { id: '3', sourceId: 'doc_2', content: 'c', embedding: [1, 0], metadata: {} },
    ])
    await d.deleteBySource('a', 'doc_1')
    const r = await d.query('a', [1, 0])
    expect(r.matches.map((m) => m.id)).toEqual(['3'])
  })

  test('flush clears the collection but keeps it registered', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [{ id: '1', content: 'a', embedding: [1, 0], metadata: {} }])
    await d.flush('a')
    const r = await d.query('a', [1, 0])
    expect(r.matches).toEqual([])
  })

  test('upsert without id assigns one', async () => {
    const d = driver()
    await d.createCollection('a', 2)
    await d.upsert('a', [{ content: 'a', embedding: [1, 0], metadata: {} }])
    const r = await d.query('a', [1, 0])
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]?.id).toBeTruthy()
  })
})
