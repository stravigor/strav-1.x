import { describe, expect, test } from 'bun:test'
import type { DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  type ColumnInfo,
  type DbSnapshot,
  defineSchema,
  diffSchemas,
  generateMigration,
  inspectDatabase,
  SchemaRegistry,
  type TableInfo,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function nonNull<T>(v: T | null | undefined, msg = 'expected non-null'): T {
  if (v === null || v === undefined) throw new Error(msg)
  return v
}

function snapshot(...tables: TableInfo[]): DbSnapshot {
  return { tables: new Map(tables.map((t) => [t.name, t])) }
}

function col(
  name: string,
  dataType = 'text',
  nullable = false,
  maxLength: number | null = null,
): ColumnInfo {
  return { name, dataType, maxLength, nullable, default: null }
}

/**
 * Records every SQL string the inspect / migration paths emit and lets a
 * test feed back scripted rows for `query`. Implements DatabaseExecutor
 * structurally.
 */
class FakeExecutor implements DatabaseExecutor {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = []
  readonly executed: Array<{ sql: string; params: readonly unknown[] }> = []
  scriptedRows: unknown[] = []

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    this.queries.push({ sql, params })
    return this.scriptedRows as T[]
  }
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    this.queries.push({ sql, params })
    return (this.scriptedRows[0] as T | undefined) ?? null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.executed.push({ sql, params })
    return 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// inspectDatabase
// ─────────────────────────────────────────────────────────────────────────────

describe('inspectDatabase', () => {
  test('issues a single information_schema join query, skips _strav_migrations', async () => {
    const db = new FakeExecutor()
    db.scriptedRows = []
    await inspectDatabase(db)
    expect(db.queries).toHaveLength(1)
    expect(nonNull(db.queries[0]).sql).toContain('information_schema.tables')
    expect(nonNull(db.queries[0]).sql).toContain('information_schema.columns')
    expect(nonNull(db.queries[0]).sql).toContain('LEFT JOIN')
    expect(nonNull(db.queries[0]).params).toEqual(['_strav_migrations'])
  })

  test('groups rows into tables → columns', async () => {
    const db = new FakeExecutor()
    db.scriptedRows = [
      {
        table_name: 'user',
        column_name: 'id',
        data_type: 'character',
        character_maximum_length: 26,
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'user',
        column_name: 'email',
        data_type: 'character varying',
        character_maximum_length: 320,
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'post',
        column_name: 'id',
        data_type: 'character',
        character_maximum_length: 26,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const snap = await inspectDatabase(db)
    expect(snap.tables.size).toBe(2)
    expect(nonNull(snap.tables.get('user')).columns).toHaveLength(2)
    const emailCol = nonNull(nonNull(snap.tables.get('user')).columns[1])
    expect(emailCol.name).toBe('email')
    expect(emailCol.maxLength).toBe(320)
    expect(nonNull(snap.tables.get('post')).columns).toHaveLength(1)
  })

  test('handles empty tables (LEFT JOIN producing null column rows)', async () => {
    const db = new FakeExecutor()
    db.scriptedRows = [
      {
        table_name: 'empty',
        column_name: null,
        data_type: null,
        character_maximum_length: null,
        is_nullable: null,
        column_default: null,
      },
    ]
    const snap = await inspectDatabase(db)
    expect(snap.tables.has('empty')).toBe(true)
    expect(nonNull(snap.tables.get('empty')).columns).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// diffSchemas
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSchemas — additive cases', () => {
  test('empty DB + registry of one schema → one create-table op', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').unique()
    })
    const registry = new SchemaRegistry().registerAll([user])
    const result = diffSchemas(registry, snapshot())
    expect(result.operations).toHaveLength(1)
    expect(nonNull(result.operations[0]).kind).toBe('create-table')
    expect(nonNull(result.operations[0]).schemaName).toBe('user')
    expect(nonNull(result.operations[0]).sql).toContain('CREATE TABLE "user"')
  })

  test('no-op when DB matches registry exactly', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(320)
    })
    const registry = new SchemaRegistry().registerAll([user])
    const result = diffSchemas(
      registry,
      snapshot({
        name: 'user',
        columns: [col('id', 'character', false, 26), col('email', 'character varying', false, 320)],
      }),
    )
    expect(result.operations).toHaveLength(0)
  })

  test('missing columns on an existing table → add-column ops', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email')
      t.string('handle').nullable() // new column
      t.timestamps() // created_at + updated_at also new
    })
    const registry = new SchemaRegistry().registerAll([user])
    const result = diffSchemas(
      registry,
      snapshot({
        name: 'user',
        columns: [col('id', 'character', false, 26), col('email', 'character varying', false, 255)],
      }),
    )
    expect(result.operations).toHaveLength(3)
    const cols = result.operations.map((op) => (op.kind === 'add-column' ? op.columnName : null))
    expect(cols).toEqual(['handle', 'created_at', 'updated_at'])
    for (const op of result.operations) {
      expect(op.sql).toContain('ALTER TABLE "user" ADD COLUMN')
    }
  })

  test('reports tables present in DB but not in registry as unknownTables (informational only)', () => {
    const registry = new SchemaRegistry()
    const result = diffSchemas(registry, snapshot({ name: 'legacy_thing', columns: [col('id')] }))
    expect(result.operations).toHaveLength(0)
    expect(result.unknownTables).toEqual(['legacy_thing'])
  })

  test('ignores columns present in DB but not on the schema (V1 is additive-only)', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
    })
    const registry = new SchemaRegistry().registerAll([user])
    const result = diffSchemas(
      registry,
      snapshot({
        name: 'user',
        columns: [col('id', 'character', false, 26), col('extra_col_we_dont_know_about')],
      }),
    )
    expect(result.operations).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// diffSchemas — ordering + cycles
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSchemas — topological ordering', () => {
  test('creates referenced tables before referrers', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('author_id').to(user)
    })
    // Register in the WRONG order on purpose — diff should sort it out.
    const registry = new SchemaRegistry().registerAll([post, user])
    const result = diffSchemas(registry, snapshot())
    const names = result.operations
      .filter((op) => op.kind === 'create-table')
      .map((op) => op.schemaName)
    expect(names).toEqual(['user', 'post'])
  })

  test('handles three-deep chains', () => {
    const a = defineSchema('a', Archetype.Entity, (t) => t.id())
    const b = defineSchema('b', Archetype.Entity, (t) => {
      t.id()
      t.reference('a_id').to(a)
    })
    const c = defineSchema('c', Archetype.Entity, (t) => {
      t.id()
      t.reference('b_id').to(b)
    })
    const registry = new SchemaRegistry().registerAll([c, b, a])
    const result = diffSchemas(registry, snapshot())
    expect(result.operations.map((op) => op.schemaName)).toEqual(['a', 'b', 'c'])
  })

  test('throws on a circular FK between two missing tables', () => {
    const a = defineSchema('a_table', Archetype.Entity, (t) => {
      t.id()
      t.reference('b_id').to('b_table')
    })
    const b = defineSchema('b_table', Archetype.Entity, (t) => {
      t.id()
      t.reference('a_id').to('a_table')
    })
    const registry = new SchemaRegistry().registerAll([a, b])
    expect(() => diffSchemas(registry, snapshot())).toThrow(/circular FK/)
  })

  test('references to schemas already in the DB impose no ordering constraint', () => {
    // `user` exists; `post` references it. Only `post` needs creating.
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('author_id').to(user)
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    const result = diffSchemas(
      registry,
      snapshot({ name: 'user', columns: [col('id', 'character', false, 26)] }),
    )
    expect(result.operations).toHaveLength(1)
    expect(nonNull(result.operations[0]).kind).toBe('create-table')
    expect(nonNull(result.operations[0]).schemaName).toBe('post')
  })

  test('add-column ops come after all create-table ops', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle').nullable() // missing on the live `user` table below
    })
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('author_id').to(user)
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    const result = diffSchemas(
      registry,
      snapshot({ name: 'user', columns: [col('id', 'character', false, 26)] }),
    )
    expect(result.operations).toHaveLength(2)
    expect(nonNull(result.operations[0]).kind).toBe('create-table') // post
    expect(nonNull(result.operations[1]).kind).toBe('add-column') // user.handle
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// generateMigration
// ─────────────────────────────────────────────────────────────────────────────

describe('generateMigration', () => {
  test('returns null when the DB matches the registry', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([user])
    const db = new FakeExecutor()
    db.scriptedRows = [
      {
        table_name: 'user',
        column_name: 'id',
        data_type: 'character',
        character_maximum_length: 26,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const generated = await generateMigration({ registry, db })
    expect(generated).toBeNull()
  })

  test('builds a Migration whose up() runs the diff ops in order', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('author_id').to(user)
    })
    const registry = new SchemaRegistry().registerAll([post, user])
    const db = new FakeExecutor()
    db.scriptedRows = [] // empty DB
    const generated = nonNull(await generateMigration({ registry, db }))
    expect(generated.diff.operations).toHaveLength(2)
    // Run up() against a fresh executor — assert it issues the right SQL.
    const runDb = new FakeExecutor()
    await generated.migration.up(runDb)
    expect(runDb.executed).toHaveLength(2)
    expect(nonNull(runDb.executed[0]).sql).toContain('CREATE TABLE "user"')
    expect(nonNull(runDb.executed[1]).sql).toContain('CREATE TABLE "post"')
  })

  test('down() drops the added columns + created tables in reverse order', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle').nullable()
    })
    const registry = new SchemaRegistry().registerAll([user])
    const db = new FakeExecutor()
    db.scriptedRows = [
      {
        table_name: 'user',
        column_name: 'id',
        data_type: 'character',
        character_maximum_length: 26,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const generated = nonNull(await generateMigration({ registry, db }))
    expect(generated.diff.operations).toHaveLength(1)
    expect(nonNull(generated.diff.operations[0]).kind).toBe('add-column')

    const runDb = new FakeExecutor()
    await generated.migration.down(runDb)
    expect(runDb.executed).toHaveLength(1)
    expect(nonNull(runDb.executed[0]).sql).toContain(
      'ALTER TABLE "user" DROP COLUMN IF EXISTS "handle"',
    )
  })

  test('name defaults to YYYYMMDDHHMMSS_auto_diff (UTC); honors explicit override', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([user])
    const db = new FakeExecutor()
    db.scriptedRows = []
    const fixed = new Date(Date.UTC(2026, 4, 28, 14, 7, 9))
    const generated = nonNull(await generateMigration({ registry, db, now: fixed }))
    expect(generated.migration.name).toBe('20260528140709_auto_diff')

    const renamed = nonNull(
      await generateMigration({ registry, db, name: 'custom_name', now: fixed }),
    )
    expect(renamed.migration.name).toBe('custom_name')
  })
})
