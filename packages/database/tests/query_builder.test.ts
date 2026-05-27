import { describe, expect, test } from 'bun:test'
import { Archetype, defineSchema, QueryBuilder } from '../src/index.ts'
import { InMemoryDatabase } from './in_memory_database.ts'

const schema = defineSchema('lead', Archetype.Entity, (t) => {
  t.id()
  t.string('email')
  t.string('status')
  t.integer('score').nullable()
  t.timestamps()
})

function builder() {
  return new QueryBuilder(schema, new InMemoryDatabase(), undefined)
}

describe('QueryBuilder — toSql', () => {
  test('bare SELECT lists every schema column', () => {
    const { sql, params } = builder().toSql()
    expect(sql).toBe(
      'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead"',
    )
    expect(params).toEqual([])
  })

  test('explicit SELECT replaces the column list', () => {
    const { sql } = builder().select('id', 'email').toSql()
    expect(sql).toBe('SELECT "id", "email" FROM "lead"')
  })

  test('where(col, value) → equality', () => {
    const { sql, params } = builder().where('email', 'a@b.com').toSql()
    expect(sql).toBe(
      'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead" WHERE "email" = $1',
    )
    expect(params).toEqual(['a@b.com'])
  })

  test('where(col, op, value) accepts operators', () => {
    const { sql, params } = builder().where('score', '>=', 80).toSql()
    expect(sql).toContain('WHERE "score" >= $1')
    expect(params).toEqual([80])
  })

  test('where({ ... }) chains multiple equalities', () => {
    const { sql, params } = builder().where({ email: 'a@b.com', status: 'active' }).toSql()
    expect(sql).toContain('WHERE "email" = $1 AND "status" = $2')
    expect(params).toEqual(['a@b.com', 'active'])
  })

  test('whereIn / whereNotIn', () => {
    const a = builder().whereIn('id', ['x', 'y', 'z']).toSql()
    expect(a.sql).toContain('WHERE "id" IN ($1, $2, $3)')
    expect(a.params).toEqual(['x', 'y', 'z'])

    const b = builder().whereNotIn('id', ['x']).toSql()
    expect(b.sql).toContain('WHERE "id" NOT IN ($1)')
    expect(b.params).toEqual(['x'])
  })

  test('whereIn with empty array → FALSE', () => {
    const { sql, params } = builder().whereIn('id', []).toSql()
    expect(sql).toContain('WHERE FALSE')
    expect(params).toEqual([])
  })

  test('whereNull / whereNotNull', () => {
    expect(builder().whereNull('score').toSql().sql).toContain('WHERE "score" IS NULL')
    expect(builder().whereNotNull('score').toSql().sql).toContain('WHERE "score" IS NOT NULL')
  })

  test('orderBy + limit + offset', () => {
    const { sql } = builder().orderBy('created_at', 'desc').limit(20).offset(40).toSql()
    expect(sql).toContain('ORDER BY "created_at" DESC LIMIT 20 OFFSET 40')
  })

  test('clauses chain immutably — base builder unchanged', () => {
    const base = builder()
    const filtered = base.where('email', 'a@b.com')
    expect(base.toSql().params).toEqual([])
    expect(filtered.toSql().params).toEqual(['a@b.com'])
  })
})

describe('QueryBuilder — terminals (via mocked DB)', () => {
  test('count() emits COUNT(*) with the same WHERE', async () => {
    const db = new InMemoryDatabase()
    // Pre-stage the count response by overriding query.
    db.executedSql.length = 0
    // We don't have a real DB; assert what was sent rather than the value.
    const b = new QueryBuilder(schema, db, undefined)
    await b.where('status', 'active').count()
    const last = db.executedSql.find((s) => s.startsWith('SELECT COUNT'))
    expect(last).toBe('SELECT COUNT(*) AS count FROM "lead" WHERE "status" = $1')
    // params recorded as a synthetic "-- params" line
    expect(db.executedSql.find((s) => s.includes('"active"'))).toBeTruthy()
  })

  test('exists() emits SELECT 1 ... LIMIT 1', async () => {
    const db = new InMemoryDatabase()
    const b = new QueryBuilder(schema, db, undefined)
    await b.where('status', 'active').exists()
    const last = db.executedSql.find((s) => s.startsWith('SELECT 1'))
    expect(last).toBe('SELECT 1 FROM "lead" WHERE "status" = $1 LIMIT 1')
  })

  test('pluck() emits SELECT <one col> ...', async () => {
    const db = new InMemoryDatabase()
    const b = new QueryBuilder(schema, db, undefined)
    await b.pluck('email')
    const last = db.executedSql.find((s) => s.startsWith('SELECT "email"'))
    expect(last).toBe('SELECT "email" FROM "lead"')
  })

  test('first() applies an implicit LIMIT 1 when none was set', async () => {
    const db = new InMemoryDatabase()
    const b = new QueryBuilder(schema, db, undefined)
    await b.first()
    expect(db.executedSql.find((s) => s.includes('LIMIT 1'))).toBeTruthy()
  })
})
