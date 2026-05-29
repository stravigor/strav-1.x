/**
 * PgvectorDriver tests — assert the SQL shapes against a SpyDb
 * stub. No real Postgres required.
 */

import { describe, expect, test } from 'bun:test'
import type { DatabaseExecutor, PostgresDatabase } from '@strav/database'
import { PgvectorDriver } from '../src/drivers/pgvector_driver.ts'
import { VectorQueryError } from '../src/rag_error.ts'

class SpyDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = []
  rows: Array<Record<string, unknown>> = []
  failNextQuery = false

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params })
    if (this.failNextQuery) {
      this.failNextQuery = false
      throw new Error('boom')
    }
    return this.rows.splice(0, this.rows.length) as T[]
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.queries.push({ sql, params })
    return (this.rows.shift() as T | null) ?? null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.queries.push({ sql, params })
    return 0
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('SpyDb.raw not implemented')
  }
}

const make = () => {
  const db = new SpyDb()
  const driver = new PgvectorDriver({ db: db as unknown as PostgresDatabase })
  return { db, driver }
}

describe('PgvectorDriver — collections', () => {
  test('createCollection is a no-op (table is shared)', async () => {
    const { db, driver } = make()
    await driver.createCollection('articles', 1536)
    expect(db.queries).toHaveLength(0)
  })

  test('deleteCollection emits DELETE WHERE collection = $1', async () => {
    const { db, driver } = make()
    await driver.deleteCollection('articles')
    const q = db.queries[0]!
    expect(q.sql).toContain('DELETE FROM "rag_vector"')
    expect(q.sql).toContain('"collection" = $1')
    expect(q.params).toEqual(['articles'])
  })
})

describe('PgvectorDriver — upsert', () => {
  test('inserts each document with vector + jsonb casts, ON CONFLICT id overwrites', async () => {
    const { db, driver } = make()
    await driver.upsert('articles', [
      {
        id: 'v_1',
        sourceId: 'doc_1',
        content: 'hello',
        embedding: [0.1, 0.2, 0.3],
        metadata: { lang: 'en' },
      },
    ])
    const q = db.queries[0]!
    expect(q.sql).toContain('INSERT INTO "rag_vector"')
    expect(q.sql).toContain('"embedding"')
    expect(q.sql).toContain('::vector')
    expect(q.sql).toContain('::jsonb')
    expect(q.sql).toContain('ON CONFLICT ("id") DO UPDATE')
    expect(q.params).toEqual([
      'v_1',
      'articles',
      'doc_1',
      'hello',
      JSON.stringify({ lang: 'en' }),
      '[0.1,0.2,0.3]',
    ])
  })

  test('empty array → no SQL', async () => {
    const { db, driver } = make()
    await driver.upsert('articles', [])
    expect(db.queries).toHaveLength(0)
  })

  test('mints id when omitted', async () => {
    const { db, driver } = make()
    await driver.upsert('articles', [
      { content: 'hello', embedding: [0.1, 0.2], metadata: {} },
    ])
    const q = db.queries[0]!
    expect(q.params[0]).toBeTruthy()
    expect(typeof q.params[0]).toBe('string')
  })
})

describe('PgvectorDriver — delete', () => {
  test('delete by ids', async () => {
    const { db, driver } = make()
    await driver.delete('articles', ['a', 'b'])
    const q = db.queries[0]!
    expect(q.sql).toContain('"id" IN ($2, $3)')
    expect(q.params).toEqual(['articles', 'a', 'b'])
  })

  test('delete with empty ids → no SQL', async () => {
    const { db, driver } = make()
    await driver.delete('articles', [])
    expect(db.queries).toHaveLength(0)
  })

  test('deleteBySource by source_id', async () => {
    const { db, driver } = make()
    await driver.deleteBySource('articles', 'doc_1')
    const q = db.queries[0]!
    expect(q.sql).toContain('"source_id" = $2')
    expect(q.params).toEqual(['articles', 'doc_1'])
  })

  test('flush deletes by collection', async () => {
    const { db, driver } = make()
    await driver.flush('articles')
    const q = db.queries[0]!
    expect(q.sql).toContain('DELETE FROM "rag_vector"')
    expect(q.params).toEqual(['articles'])
  })
})

describe('PgvectorDriver — query', () => {
  test('emits cosine similarity expression, ORDER BY <=> + LIMIT', async () => {
    const { db, driver } = make()
    db.rows = [
      {
        id: 'v_1',
        source_id: null,
        content: 'a',
        metadata: { lang: 'en' },
        score: 0.95,
      },
    ]
    const r = await driver.query('articles', [0.1, 0.2], { topK: 3 })
    const q = db.queries[0]!
    expect(q.sql).toContain('FROM "rag_vector"')
    expect(q.sql).toContain('"collection" = $1')
    expect(q.sql).toContain('"embedding" <=> $2::vector')
    expect(q.sql).toContain('ORDER BY "embedding" <=> $2::vector')
    expect(q.sql).toContain('LIMIT')
    // params: [collection, vector_literal, topK]
    expect(q.params).toEqual(['articles', '[0.1,0.2]', 3])
    expect(r.matches).toEqual([
      { id: 'v_1', content: 'a', score: 0.95, metadata: { lang: 'en' }, sourceId: null },
    ])
  })

  test('appends a threshold predicate when set', async () => {
    const { db, driver } = make()
    await driver.query('articles', [0, 1], { threshold: 0.7 })
    const q = db.queries[0]!
    expect(q.sql).toContain('>= $3')
    expect(q.params).toEqual(['articles', '[0,1]', 0.7, 5])
  })

  test('appends jsonb containment predicates for filter keys', async () => {
    const { db, driver } = make()
    await driver.query('articles', [0, 1], { filter: { lang: 'en', kind: 'doc' } })
    const q = db.queries[0]!
    expect(q.sql).toContain('"metadata" @>')
    // Two filter keys → two jsonb_build_object predicates.
    const occurrences = (q.sql.match(/jsonb_build_object/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  test('wraps driver errors in VectorQueryError', async () => {
    const { db, driver } = make()
    db.failNextQuery = true
    await expect(driver.query('articles', [0, 1])).rejects.toBeInstanceOf(VectorQueryError)
  })

  test('parses jsonb metadata returned as a string', async () => {
    const { db, driver } = make()
    db.rows = [
      {
        id: 'v_1',
        source_id: 'doc_1',
        content: 'a',
        metadata: '{"lang":"en"}',
        score: '0.9',
      },
    ]
    const r = await driver.query('articles', [0, 1])
    expect(r.matches[0]?.metadata).toEqual({ lang: 'en' })
    expect(r.matches[0]?.score).toBeCloseTo(0.9, 5)
  })

  test('rejects filter keys containing NUL bytes', async () => {
    const { driver } = make()
    await expect(
      driver.query('a', [0, 1], { filter: { 'bad\0key': 'x' } }),
    ).rejects.toBeInstanceOf(VectorQueryError)
  })
})

describe('PgvectorDriver — table override', () => {
  test('honors a custom table name across every operation', async () => {
    const db = new SpyDb()
    const driver = new PgvectorDriver({
      db: db as unknown as PostgresDatabase,
      table: 'app_vectors',
    })
    await driver.upsert('a', [{ id: 'v', content: 'c', embedding: [0], metadata: {} }])
    await driver.flush('a')
    for (const q of db.queries) expect(q.sql).toContain('"app_vectors"')
  })
})
