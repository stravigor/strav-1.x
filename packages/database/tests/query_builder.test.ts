import { describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import { Archetype, defineSchema, QueryBuilder } from '../src/index.ts'
import { InMemoryDatabase } from './in_memory_database.ts'

/**
 * Database stub for cursor-pagination tests — scripts query results
 * and records every SQL + params for assertion. Pop one batch per
 * `query()` call.
 */
class FakeRowDb implements Database {
  readonly executedSql: Array<{ sql: string; params: readonly unknown[] }> = []
  scriptedRows: Record<string, unknown>[][] = []

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.executedSql.push({ sql, params })
    return (this.scriptedRows.shift() ?? []) as T[]
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }
  async execute(): Promise<number> {
    return 0
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close(): Promise<void> {}
  raw(): never {
    throw new Error('FakeRowDb.raw not implemented')
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// CTE — .cte / .cteRecursive / .from(name)
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder — .cte', () => {
  test('single CTE prepends a WITH clause to the main SELECT', () => {
    const sub = builder().where('status', 'active')
    const { sql, params } = builder().cte('active_leads', sub).toSql()
    expect(sql).toBe(
      'WITH "active_leads" AS (SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead" WHERE "status" = $1) ' +
        'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead"',
    )
    expect(params).toEqual(['active'])
  })

  test('multiple CTEs comma-separate within a single WITH clause', () => {
    const a = builder().where('status', 'active')
    const b = builder().where('status', 'pending')
    const { sql, params } = builder().cte('a', a).cte('b', b).toSql()
    expect(sql).toContain('WITH "a" AS (')
    expect(sql).toContain('), "b" AS (')
    // Each sub's `$N` placeholder is renumbered against the shared accumulator.
    expect(params).toEqual(['active', 'pending'])
    expect(sql).toMatch(/"status" = \$1.*"status" = \$2/)
  })

  test('CTE body placeholders shift to make room for main-query placeholders', () => {
    const sub = builder().where('status', 'active')
    const { sql, params } = builder().cte('active', sub).where('email', 'a@b.com').toSql()
    // The CTE body grabs $1, the main query's WHERE grabs $2.
    expect(sql).toMatch(/"status" = \$1.*\) SELECT.*"email" = \$2/)
    expect(params).toEqual(['active', 'a@b.com'])
  })

  test('.from(name) overrides the FROM clause', () => {
    const { sql } = builder().from('active_leads').toSql()
    expect(sql).toBe(
      'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "active_leads"',
    )
  })

  test('CTE + .from(cte) — typical "read from the CTE" pattern', () => {
    const sub = builder().where('status', 'active')
    const { sql, params } = builder()
      .cte('active_leads', sub)
      .from('active_leads')
      .orderBy('created_at', 'desc')
      .limit(10)
      .toSql()
    expect(sql).toBe(
      'WITH "active_leads" AS (SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead" WHERE "status" = $1) ' +
        'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "active_leads" ' +
        'ORDER BY "created_at" DESC LIMIT 10',
    )
    expect(params).toEqual(['active'])
  })

  test('.cte rejects an empty name', () => {
    expect(() => builder().cte('', builder())).toThrow(/non-empty string/)
  })

  test('raw SQL body — placeholders are renumbered against the accumulator', () => {
    const { sql, params } = builder()
      .cte('raw_cte', {
        sql: 'SELECT id, name FROM other_table WHERE col = $1 AND col2 = $2',
        params: ['x', 'y'],
      })
      .where('email', 'a@b.com')
      .toSql()
    expect(sql).toContain(
      'WITH "raw_cte" AS (SELECT id, name FROM other_table WHERE col = $1 AND col2 = $2)',
    )
    expect(sql).toContain('"email" = $3')
    expect(params).toEqual(['x', 'y', 'a@b.com'])
  })
})

describe('QueryBuilder — .cteRecursive', () => {
  test('emits the RECURSIVE keyword when at least one CTE is recursive', () => {
    const { sql } = builder().cteRecursive('tree', { sql: 'SELECT 1', params: [] }).toSql()
    expect(sql).toContain('WITH RECURSIVE "tree" AS (SELECT 1)')
  })

  test('RECURSIVE applies to the whole WITH list if any CTE is recursive', () => {
    const { sql } = builder()
      .cte('cte_a', { sql: 'SELECT 1', params: [] })
      .cteRecursive('tree', { sql: 'SELECT 2', params: [] })
      .toSql()
    // Only one RECURSIVE token at the WITH-clause level.
    expect(sql.match(/RECURSIVE/g)?.length).toBe(1)
    expect(sql).toContain('WITH RECURSIVE "cte_a" AS')
  })

  test('typical recursive CTE — anchor UNION ALL recursive term via raw SQL body', () => {
    const { sql, params } = builder()
      .cteRecursive('tree', {
        sql: `SELECT id, parent_id FROM "category" WHERE parent_id IS NULL UNION ALL SELECT c.id, c.parent_id FROM "category" c JOIN "tree" t ON c.parent_id = t.id`,
        params: [],
      })
      .from('tree')
      .toSql()
    expect(sql).toContain('WITH RECURSIVE "tree" AS (')
    expect(sql).toContain('FROM "tree"')
    expect(params).toEqual([])
  })

  test('.cteRecursive rejects an empty name', () => {
    expect(() => builder().cteRecursive('', { sql: 'SELECT 1', params: [] })).toThrow(
      /non-empty string/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNION / UNION ALL
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder — .union / .unionAll', () => {
  test('UNION wraps both branches and concatenates', () => {
    const left = builder().where('status', 'active')
    const right = builder().where('status', 'pending')
    const { sql, params } = left.union(right).toSql()
    expect(sql).toBe(
      'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead" WHERE "status" = $1 ' +
        'UNION (SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead" WHERE "status" = $2)',
    )
    expect(params).toEqual(['active', 'pending'])
  })

  test('UNION ALL emits the ALL keyword', () => {
    const left = builder().where('status', 'active')
    const right = builder().where('status', 'pending')
    const { sql } = left.unionAll(right).toSql()
    expect(sql).toContain('UNION ALL (')
  })

  test('chained unions compose in order', () => {
    const a = builder().where('status', 'a')
    const b = builder().where('status', 'b')
    const c = builder().where('status', 'c')
    const { sql, params } = a.union(b).unionAll(c).toSql()
    expect(sql).toMatch(/UNION \(.*\) UNION ALL \(/)
    expect(params).toEqual(['a', 'b', 'c'])
  })

  test('union body placeholders renumber against the shared accumulator', () => {
    const left = builder().where('email', 'a@b.com')
    const right = builder().where('email', 'c@d.com')
    const { sql, params } = left.union(right).toSql()
    expect(sql).toMatch(/"email" = \$1.*"email" = \$2/)
    expect(params).toEqual(['a@b.com', 'c@d.com'])
  })

  test('union with a raw body — `$N` placeholders are renumbered', () => {
    const left = builder().where('status', 'active')
    const { sql, params } = left
      .unionAll({ sql: 'SELECT * FROM "lead_archive" WHERE id = $1', params: ['x-1'] })
      .toSql()
    expect(sql).toContain('UNION ALL (SELECT * FROM "lead_archive" WHERE id = $2)')
    expect(params).toEqual(['active', 'x-1'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Clone immutability — new fields carry through chained modifiers
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder — CTE / union clone semantics', () => {
  test('chaining modifiers after .cte() preserves the CTE on the result', () => {
    const sub = builder().where('status', 'active')
    const chained = builder().cte('active', sub).where('email', 'a@b.com').limit(5)
    expect(chained.toSql().sql).toContain('WITH "active" AS (')
    expect(chained.toSql().sql).toContain('LIMIT 5')
  })

  test('chaining modifiers after .union() preserves the union on the result', () => {
    const left = builder().where('status', 'active')
    const right = builder().where('status', 'pending')
    const chained = left.union(right).orderBy('created_at', 'desc')
    // ORDER BY emits inside the LEFT (this) branch by V1 semantics.
    expect(chained.toSql().sql).toMatch(/ORDER BY "created_at" DESC UNION/)
  })

  test('.cte/.union/.from each return a fresh builder — original is unchanged', () => {
    const orig = builder()
    const sub = builder().where('status', 'active')
    orig.cte('a', sub)
    orig.from('cte_name')
    orig.union(sub)
    expect(orig.toSql().sql).toBe(
      'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead"',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// V1 boundaries: count/exists/pluck/paginate ignore CTE + union
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder — count/exists/pluck ignore CTE + union (documented V1 boundary)', () => {
  test('count() runs against the main builder only (no WITH, no UNION)', async () => {
    const db = new InMemoryDatabase()
    const b = new QueryBuilder(schema, db, undefined)
      .cte('x', { sql: 'SELECT 1', params: [] })
      .unionAll({ sql: 'SELECT 2', params: [] })
    await b.count()
    const countSql = db.executedSql.find((s) => s.includes('COUNT(*)'))
    expect(countSql).toBeTruthy()
    expect(countSql).not.toContain('WITH')
    expect(countSql).not.toContain('UNION')
  })

  test('exists() runs against the main builder only', async () => {
    const db = new InMemoryDatabase()
    const b = new QueryBuilder(schema, db, undefined).cte('x', { sql: 'SELECT 1', params: [] })
    await b.exists()
    const existsSql = db.executedSql.find((s) => s.includes('LIMIT 1'))
    expect(existsSql).toBeTruthy()
    expect(existsSql).not.toContain('WITH')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// .cursorPaginate
// ─────────────────────────────────────────────────────────────────────────────

function rowDbBuilder(db: FakeRowDb) {
  return new QueryBuilder(schema, db as unknown as DatabaseExecutor, undefined)
}

describe('QueryBuilder — .cursorPaginate validation', () => {
  test('throws when no .orderBy was set', async () => {
    const db = new FakeRowDb()
    await expect(rowDbBuilder(db).cursorPaginate({ perPage: 10 })).rejects.toThrow(
      /exactly one .orderBy/,
    )
  })

  test('throws when multiple .orderBy were set', async () => {
    const db = new FakeRowDb()
    await expect(
      rowDbBuilder(db).orderBy('created_at').orderBy('id').cursorPaginate({ perPage: 10 }),
    ).rejects.toThrow(/exactly one .orderBy/)
  })

  test('throws when both after and before are supplied', async () => {
    const db = new FakeRowDb()
    await expect(
      rowDbBuilder(db)
        .orderBy('created_at')
        .cursorPaginate({ perPage: 10, after: 'x', before: 'y' }),
    ).rejects.toThrow(/after.*before/)
  })

  test('throws when perPage is not a positive integer', async () => {
    const db = new FakeRowDb()
    await expect(
      rowDbBuilder(db).orderBy('created_at').cursorPaginate({ perPage: 0 }),
    ).rejects.toThrow(/positive integer/)
    await expect(
      rowDbBuilder(db).orderBy('created_at').cursorPaginate({ perPage: 1.5 }),
    ).rejects.toThrow(/positive integer/)
  })

  test('throws when .cte() or .union() is also set', async () => {
    const db = new FakeRowDb()
    await expect(
      rowDbBuilder(db)
        .orderBy('created_at')
        .cte('x', { sql: 'SELECT 1', params: [] })
        .cursorPaginate({ perPage: 10 }),
    ).rejects.toThrow(/does not compose with/)

    await expect(
      rowDbBuilder(db)
        .orderBy('created_at')
        .unionAll({ sql: 'SELECT 1', params: [] })
        .cursorPaginate({ perPage: 10 }),
    ).rejects.toThrow(/does not compose with/)
  })

  test('throws on a malformed cursor', async () => {
    const db = new FakeRowDb()
    await expect(
      rowDbBuilder(db).orderBy('created_at').cursorPaginate({ perPage: 10, after: 'not-base64' }),
    ).rejects.toThrow(/malformed cursor/)
  })
})

describe('QueryBuilder — .cursorPaginate first page (no cursor)', () => {
  test('emits ORDER BY <sort> DESC, "id" DESC + LIMIT perPage+1 for DESC sort', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[]] // empty result
    await rowDbBuilder(db).orderBy('created_at', 'desc').cursorPaginate({ perPage: 20 })
    expect(db.executedSql).toHaveLength(1)
    const { sql } = db.executedSql[0] as { sql: string }
    expect(sql).toContain('ORDER BY "created_at" DESC, "id" DESC')
    expect(sql).toContain('LIMIT 21')
  })

  test('emits ASC for ASC sort', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[]]
    await rowDbBuilder(db).orderBy('created_at', 'asc').cursorPaginate({ perPage: 5 })
    const { sql } = db.executedSql[0] as { sql: string }
    expect(sql).toContain('ORDER BY "created_at" ASC, "id" ASC')
    expect(sql).toContain('LIMIT 6')
  })

  test('hasMore=false + nextCursor=null when fewer than perPage+1 rows come back', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [
      [
        { id: 'a', email: 'a@b.com', status: 'active', score: 1, created_at: 1, updated_at: 1 },
        { id: 'b', email: 'b@b.com', status: 'active', score: 2, created_at: 2, updated_at: 2 },
      ],
    ]
    const result = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .cursorPaginate({ perPage: 5 })
    expect(result.data).toHaveLength(2)
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
    expect(result.prevCursor).toBeNull()
  })

  test('hasMore=true + nextCursor set + extra row dropped when perPage+1 rows come back', async () => {
    const db = new FakeRowDb()
    const make = (id: string, ts: number) => ({
      id,
      email: `${id}@b.com`,
      status: 'active',
      score: 0,
      created_at: ts,
      updated_at: ts,
    })
    // 3 rows for perPage=2 → hasMore, drop the third.
    db.scriptedRows = [[make('a', 3), make('b', 2), make('c', 1)]]
    const result = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .cursorPaginate({ perPage: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).not.toBeNull()
    // Cursor encodes the last visible row's (created_at, id) — here ('b', 2).
    const payload = JSON.parse(Buffer.from(result.nextCursor as string, 'base64url').toString())
    expect(payload).toEqual({ v: 2, i: 'b' })
  })
})

describe('QueryBuilder — .cursorPaginate with `after` cursor', () => {
  test('appends tuple WHERE with < for DESC sort + correct param order', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[]]
    const cursor = Buffer.from(JSON.stringify({ v: 100, i: 'last-id' }), 'utf8').toString(
      'base64url',
    )
    await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .cursorPaginate({ perPage: 10, after: cursor })
    const call = db.executedSql[0] as { sql: string; params: readonly unknown[] }
    expect(call.sql).toContain('WHERE ("created_at", "id") < ($1, $2)')
    expect(call.params).toEqual([100, 'last-id'])
  })

  test('appends tuple WHERE with > for ASC sort', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[]]
    const cursor = Buffer.from(JSON.stringify({ v: 1, i: 'x' }), 'utf8').toString('base64url')
    await rowDbBuilder(db)
      .orderBy('created_at', 'asc')
      .cursorPaginate({ perPage: 10, after: cursor })
    const { sql } = db.executedSql[0] as { sql: string }
    expect(sql).toContain('WHERE ("created_at", "id") > ($1, $2)')
  })

  test('composes with existing .where() — both fragments AND-joined', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[]]
    const cursor = Buffer.from(JSON.stringify({ v: 5, i: 'x' }), 'utf8').toString('base64url')
    await rowDbBuilder(db)
      .where('status', 'active')
      .orderBy('created_at', 'desc')
      .cursorPaginate({ perPage: 10, after: cursor })
    const call = db.executedSql[0] as { sql: string; params: readonly unknown[] }
    expect(call.sql).toContain('WHERE "status" = $1 AND ("created_at", "id") < ($2, $3)')
    expect(call.params).toEqual(['active', 5, 'x'])
  })
})

describe('QueryBuilder — .cursorPaginate with `before` cursor (backward page)', () => {
  test('reverses ORDER BY direction internally + re-reverses result', async () => {
    const db = new FakeRowDb()
    const make = (id: string, ts: number) => ({
      id,
      email: `${id}@b.com`,
      status: 'a',
      score: 0,
      created_at: ts,
      updated_at: ts,
    })
    // DB sees ASC order (reversed); result rows come in ASC by created_at: [a(1), b(2), c(3)]
    // After re-reverse for the caller, data should be DESC: [c, b, a].
    db.scriptedRows = [[make('a', 1), make('b', 2), make('c', 3)]]
    const cursor = Buffer.from(JSON.stringify({ v: 5, i: 'x' }), 'utf8').toString('base64url')
    const result = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .cursorPaginate({ perPage: 5, before: cursor })
    // Internal SQL: reversed direction (ASC) and `>` comparison.
    const call = db.executedSql[0] as { sql: string }
    expect(call.sql).toContain('ORDER BY "created_at" ASC, "id" ASC')
    expect(call.sql).toContain('("created_at", "id") > ($1, $2)')
    // External: data re-reversed so caller still sees DESC order.
    expect((result.data[0] as Record<string, unknown>).id).toBe('c')
    expect((result.data[2] as Record<string, unknown>).id).toBe('a')
  })
})

describe('QueryBuilder — cursor encoding edge cases', () => {
  test('Date sort values encode as ISO strings + roundtrip into the WHERE params', async () => {
    const db = new FakeRowDb()
    const date = new Date('2026-05-28T10:00:00.000Z')
    db.scriptedRows = [
      [
        {
          id: 'a',
          email: 'a@b.com',
          status: 'a',
          score: 0,
          created_at: date,
          updated_at: date,
        },
      ],
    ]
    // First page — page returns 1 row, so no hasMore; nextCursor should be null.
    // To get a non-null cursor, return perPage+1 rows.
    const date2 = new Date('2026-05-27T10:00:00.000Z')
    db.scriptedRows = [
      [
        {
          id: 'a',
          email: 'a@b.com',
          status: 'a',
          score: 0,
          created_at: date,
          updated_at: date,
        },
        {
          id: 'b',
          email: 'b@b.com',
          status: 'a',
          score: 0,
          created_at: date2,
          updated_at: date2,
        },
      ],
    ]
    const result = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .cursorPaginate({ perPage: 1 })
    expect(result.data).toHaveLength(1)
    expect(result.hasMore).toBe(true)
    const payload = JSON.parse(Buffer.from(result.nextCursor as string, 'base64url').toString())
    // Date encoded as ISO string in the cursor.
    expect(payload.v).toBe(date.toISOString())
    expect(payload.i).toBe('a')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// .chunk
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder — .chunk', () => {
  test('walks every page until empty + returns total rows processed', async () => {
    const db = new FakeRowDb()
    const make = (id: string, ts: number) => ({
      id,
      email: `${id}@b.com`,
      status: 'a',
      score: 0,
      created_at: ts,
      updated_at: ts,
    })
    // Three pages of 2 + a fourth empty page to terminate.
    db.scriptedRows = [
      [make('1', 10), make('2', 9), make('3', 8)], // hasMore (perPage=2 + 1)
      [make('3', 8), make('4', 7), make('5', 6)],
      [make('5', 6), make('6', 5)],
    ]
    const pages: number[] = []
    const total = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .chunk(2, (rows) => {
        pages.push(rows.length)
      })
    expect(total).toBe(6)
    expect(pages).toEqual([2, 2, 2])
  })

  test('returning false from fn short-circuits the chunk loop', async () => {
    const db = new FakeRowDb()
    const make = (id: string, ts: number) => ({
      id,
      email: `${id}@b.com`,
      status: 'a',
      score: 0,
      created_at: ts,
      updated_at: ts,
    })
    db.scriptedRows = [
      [make('1', 10), make('2', 9), make('3', 8)],
      [make('3', 8), make('4', 7), make('5', 6)],
    ]
    let calls = 0
    const total = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .chunk(2, () => {
        calls++
        return false
      })
    expect(calls).toBe(1)
    expect(total).toBe(2)
  })

  test('returns 0 when the result set is empty', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[]]
    let calls = 0
    const total = await rowDbBuilder(db)
      .orderBy('created_at', 'desc')
      .chunk(10, () => {
        calls++
      })
    expect(total).toBe(0)
    expect(calls).toBe(0)
  })

  test('propagates a throw from fn', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [
      [
        {
          id: 'a',
          email: 'a@b.com',
          status: 'a',
          score: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
    ]
    await expect(
      rowDbBuilder(db)
        .orderBy('created_at', 'desc')
        .chunk(10, () => {
          throw new Error('boom')
        }),
    ).rejects.toThrow(/boom/)
  })
})

// ─── Joins ──────────────────────────────────────────────────────────────────

describe('QueryBuilder — joins', () => {
  test('.join emits `JOIN <table> ON <left> = <right>` between FROM and WHERE', () => {
    const { sql } = builder().join('users', 'users.id', 'lead.user_id').toSql()
    expect(sql).toBe(
      'SELECT "id", "email", "status", "score", "created_at", "updated_at" FROM "lead" JOIN "users" ON "users"."id" = "lead"."user_id"',
    )
  })

  test('.leftJoin emits LEFT JOIN', () => {
    const { sql } = builder().leftJoin('users', 'users.id', 'lead.user_id').toSql()
    expect(sql).toContain(' LEFT JOIN "users" ON "users"."id" = "lead"."user_id"')
  })

  test('.crossJoin emits CROSS JOIN without ON', () => {
    const { sql } = builder().crossJoin('tally').toSql()
    expect(sql).toContain(' CROSS JOIN "tally"')
    expect(sql).not.toContain(' ON ')
  })

  test('multiple joins preserve registration order', () => {
    const { sql } = builder()
      .join('users', 'users.id', 'lead.user_id')
      .leftJoin('tenants', 'tenants.id', 'users.tenant_id')
      .toSql()
    expect(sql).toContain(' JOIN "users" ON "users"."id" = "lead"."user_id" LEFT JOIN "tenants"')
  })

  test('qualified column refs in WHERE split on `.` and quote each segment', () => {
    const { sql, params } = builder()
      .join('users', 'users.id', 'lead.user_id')
      .where('users.role', 'admin')
      .toSql()
    expect(sql).toContain('WHERE "users"."role" = $1')
    expect(params).toEqual(['admin'])
  })

  test('qualified column refs in ORDER BY are split + quoted', () => {
    const { sql } = builder()
      .join('users', 'users.id', 'lead.user_id')
      .orderBy('users.created_at', 'desc')
      .toSql()
    expect(sql).toContain('ORDER BY "users"."created_at" DESC')
  })

  test('select supports `table.*` and qualified columns', () => {
    const { sql } = builder()
      .join('users', 'users.id', 'lead.user_id')
      .select('lead.*', 'users.name')
      .toSql()
    expect(sql).toBe(
      'SELECT "lead".*, "users"."name" FROM "lead" JOIN "users" ON "users"."id" = "lead"."user_id"',
    )
  })

  test('soft-delete predicate is qualified with the main table when joins are present', () => {
    const softSchema = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.string('title')
      t.timestamps()
      t.softDeletes()
    })
    const qb = new QueryBuilder(softSchema, new InMemoryDatabase(), undefined)
    const { sql } = qb.join('users', 'users.id', 'post.user_id').toSql()
    expect(sql).toContain('WHERE "post"."deleted_at" IS NULL')
  })

  test('soft-delete predicate stays bare when no joins are present', () => {
    const softSchema = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.string('title')
      t.timestamps()
      t.softDeletes()
    })
    const { sql } = new QueryBuilder(softSchema, new InMemoryDatabase(), undefined).toSql()
    expect(sql).toContain('WHERE "deleted_at" IS NULL')
    expect(sql).not.toContain('"post"."deleted_at"')
  })

  test('joins are included in count / exists / pluck terminals', async () => {
    const db = new FakeRowDb()
    db.scriptedRows = [[{ count: 7 }]]
    await new QueryBuilder(schema, db, undefined)
      .join('users', 'users.id', 'lead.user_id')
      .where('users.role', 'admin')
      .count()
    expect(db.executedSql[0]?.sql).toBe(
      'SELECT COUNT(*) AS count FROM "lead" JOIN "users" ON "users"."id" = "lead"."user_id" WHERE "users"."role" = $1',
    )
  })

  test('cursorPaginate refuses to compose with .join()', async () => {
    await expect(
      builder()
        .join('users', 'users.id', 'lead.user_id')
        .orderBy('id', 'asc')
        .cursorPaginate({ perPage: 10 }),
    ).rejects.toThrow(/does not compose with .* `\.join\(\)`/)
  })

  test('immutable chain — each join returns a fresh builder', () => {
    const base = builder()
    const joined = base.join('users', 'users.id', 'lead.user_id')
    expect(base.toSql().sql).not.toContain('JOIN')
    expect(joined.toSql().sql).toContain('JOIN')
  })
})
