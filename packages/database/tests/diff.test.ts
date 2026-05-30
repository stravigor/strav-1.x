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
  extras: { numericPrecision?: number | null; numericScale?: number | null } = {},
): ColumnInfo {
  return {
    name,
    dataType,
    maxLength,
    numericPrecision: extras.numericPrecision ?? null,
    numericScale: extras.numericScale ?? null,
    nullable,
    default: null,
  }
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
    const op = nonNull(result.operations[0])
    expect(op.kind).toBe('create-table')
    if (op.kind === 'create-table') {
      expect(op.schemaName).toBe('user')
    }
    expect(op.sql).toContain('CREATE TABLE "user"')
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
      t.foreign('author_id').to(user)
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
      t.foreign('a_id').to(a)
    })
    const c = defineSchema('c', Archetype.Entity, (t) => {
      t.id()
      t.foreign('b_id').to(b)
    })
    const registry = new SchemaRegistry().registerAll([c, b, a])
    const result = diffSchemas(registry, snapshot())
    expect(
      result.operations.map((op) => (op.kind === 'create-table' ? op.schemaName : null)),
    ).toEqual(['a', 'b', 'c'])
  })

  test('throws on a circular FK between two missing tables', () => {
    const a = defineSchema('a_table', Archetype.Entity, (t) => {
      t.id()
      t.foreign('b_id').to('b_table')
    })
    const b = defineSchema('b_table', Archetype.Entity, (t) => {
      t.id()
      t.foreign('a_id').to('a_table')
    })
    const registry = new SchemaRegistry().registerAll([a, b])
    expect(() => diffSchemas(registry, snapshot())).toThrow(/circular FK/)
  })

  test('references to schemas already in the DB impose no ordering constraint', () => {
    // `user` exists; `post` references it. Only `post` needs creating.
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.foreign('author_id').to(user)
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    const result = diffSchemas(
      registry,
      snapshot({ name: 'user', columns: [col('id', 'character', false, 26)] }),
    )
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    expect(op.kind).toBe('create-table')
    if (op.kind === 'create-table') {
      expect(op.schemaName).toBe('post')
    }
  })

  test('add-column ops come after all create-table ops', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle').nullable() // missing on the live `user` table below
    })
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.foreign('author_id').to(user)
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
      t.foreign('author_id').to(user)
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

// ─────────────────────────────────────────────────────────────────────────────
// diffSchemas — destructive ops (drops + renames)
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSchemas — drops (gated by allowDrop)', () => {
  test('unknown table: reported in unknownTables but NOT dropped by default', () => {
    const registry = new SchemaRegistry()
    const result = diffSchemas(registry, snapshot({ name: 'legacy', columns: [col('id')] }))
    expect(result.unknownTables).toEqual(['legacy'])
    expect(result.operations).toEqual([])
  })

  test('unknown table: dropped when allowDrop is true', () => {
    const registry = new SchemaRegistry()
    const result = diffSchemas(registry, snapshot({ name: 'legacy', columns: [col('id')] }), {
      allowDrop: true,
    })
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    expect(op.kind).toBe('drop-table')
    if (op.kind === 'drop-table') {
      expect(op.tableName).toBe('legacy')
      expect(op.sql).toBe('DROP TABLE "legacy"')
    }
    // unknownTables still populated — informational, not in-place of the op.
    expect(result.unknownTables).toEqual(['legacy'])
  })

  test('unknown column on a known table: kept by default, dropped with allowDrop', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('legacy_field')],
    })

    const defaultResult = diffSchemas(registry, snap)
    expect(defaultResult.operations).toEqual([])

    const dropResult = diffSchemas(registry, snap, { allowDrop: true })
    expect(dropResult.operations).toHaveLength(1)
    const op = nonNull(dropResult.operations[0])
    expect(op.kind).toBe('drop-column')
    if (op.kind === 'drop-column') {
      expect(op.tableName).toBe('user')
      expect(op.columnName).toBe('legacy_field')
      expect(op.sql).toBe('ALTER TABLE "user" DROP COLUMN "legacy_field"')
    }
  })

  test('multiple table drops emit in reverse alphabetical order', () => {
    const registry = new SchemaRegistry()
    const result = diffSchemas(
      registry,
      snapshot(
        { name: 'a_legacy', columns: [col('id')] },
        { name: 'b_legacy', columns: [col('id')] },
        { name: 'c_legacy', columns: [col('id')] },
      ),
      { allowDrop: true },
    )
    expect(
      result.operations
        .filter((op) => op.kind === 'drop-table')
        .map((op) => (op.kind === 'drop-table' ? op.tableName : null)),
    ).toEqual(['c_legacy', 'b_legacy', 'a_legacy'])
  })
})

describe('diffSchemas — renames', () => {
  test('explicit table rename converts what would look like drop+add into a rename op', () => {
    const account = defineSchema('account', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([account])
    const snap = snapshot({ name: 'user', columns: [col('id', 'character', false, 26)] })

    const result = diffSchemas(registry, snap, {
      renames: { tables: { user: 'account' } },
      allowDrop: true, // wouldn't matter — the rename consumes both sides
    })

    const renameOps = result.operations.filter((op) => op.kind === 'rename-table')
    expect(renameOps).toHaveLength(1)
    const op = nonNull(renameOps[0])
    if (op.kind === 'rename-table') {
      expect(op.from).toBe('user')
      expect(op.to).toBe('account')
      expect(op.sql).toBe('ALTER TABLE "user" RENAME TO "account"')
    }
    // No create-table for `account` (already exists post-rename).
    expect(result.operations.filter((o) => o.kind === 'create-table')).toEqual([])
    // No drop-table for `user` (consumed by rename).
    expect(result.operations.filter((o) => o.kind === 'drop-table')).toEqual([])
  })

  test('explicit column rename converts add+drop into a rename op', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle')
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [
        col('id', 'character', false, 26),
        col('username', 'character varying', false, 255),
      ],
    })

    const result = diffSchemas(registry, snap, {
      renames: { columns: { user: { username: 'handle' } } },
      allowDrop: true,
    })

    const renameOps = result.operations.filter((op) => op.kind === 'rename-column')
    expect(renameOps).toHaveLength(1)
    const op = nonNull(renameOps[0])
    if (op.kind === 'rename-column') {
      expect(op.tableName).toBe('user')
      expect(op.from).toBe('username')
      expect(op.to).toBe('handle')
      expect(op.sql).toBe('ALTER TABLE "user" RENAME COLUMN "username" TO "handle"')
    }
    // No add-column / drop-column for the renamed pair.
    expect(result.operations.filter((o) => o.kind === 'add-column')).toEqual([])
    expect(result.operations.filter((o) => o.kind === 'drop-column')).toEqual([])
  })

  test('renames apply before drop detection so unknownTables stays clean', () => {
    const account = defineSchema('account', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([account])
    const snap = snapshot({ name: 'user', columns: [col('id', 'character', false, 26)] })

    const result = diffSchemas(registry, snap, {
      renames: { tables: { user: 'account' } },
    })
    expect(result.unknownTables).toEqual([])
  })

  test('column renames must be keyed by the SCHEMA name (post-table-rename)', () => {
    // `users` table is renamed to `user`, then its `email_address` column is
    // renamed to `email`. The column-rename key is `user` (the schema name).
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email')
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'users',
      columns: [
        col('id', 'character', false, 26),
        col('email_address', 'character varying', false, 255),
      ],
    })

    const result = diffSchemas(registry, snap, {
      renames: {
        tables: { users: 'user' },
        columns: { user: { email_address: 'email' } },
      },
    })

    expect(result.operations.map((o) => o.kind)).toEqual(['rename-table', 'rename-column'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// generateMigration — destructive options forward + down() inverses
// ─────────────────────────────────────────────────────────────────────────────

describe('generateMigration — destructive options', () => {
  test('allowDrop flows through to the diff engine', async () => {
    const registry = new SchemaRegistry()
    const db = new FakeExecutor()
    db.scriptedRows = [
      {
        table_name: 'legacy',
        column_name: 'id',
        data_type: 'character',
        character_maximum_length: 26,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const generated = nonNull(await generateMigration({ registry, db, allowDrop: true }))
    const ops = generated.diff.operations
    expect(ops.map((o) => o.kind)).toContain('drop-table')
  })

  test('down() inverses include rename reverses + no-op for drops', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([user])
    const db = new FakeExecutor()
    // Live DB has `users` (note the s). Rename it.
    db.scriptedRows = [
      {
        table_name: 'users',
        column_name: 'id',
        data_type: 'character',
        character_maximum_length: 26,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const generated = nonNull(
      await generateMigration({
        registry,
        db,
        renames: { tables: { users: 'user' } },
      }),
    )
    const runDb = new FakeExecutor()
    await generated.migration.down(runDb)
    // The down should reverse-rename — `user` → `users`.
    expect(runDb.executed.some((q) => q.sql.includes('ALTER TABLE "user" RENAME TO "users"'))).toBe(
      true,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// diffSchemas — type + nullability drift (gated by allowAlter)
// ─────────────────────────────────────────────────────────────────────────────

describe('diffSchemas — alters (gated by allowAlter)', () => {
  test('varchar widening: DB has varchar(255), schema asks for varchar(500)', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(500)
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('email', 'character varying', false, 255)],
    })

    // Default: drift is ignored.
    expect(diffSchemas(registry, snap).operations).toEqual([])

    // allowAlter: emits an alter-column op.
    const result = diffSchemas(registry, snap, { allowAlter: true })
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    expect(op.kind).toBe('alter-column')
    if (op.kind === 'alter-column') {
      expect(op.tableName).toBe('user')
      expect(op.columnName).toBe('email')
      expect(op.from).toEqual({ type: 'varchar(255)', nullable: false })
      expect(op.to).toEqual({ type: 'varchar(500)', nullable: false })
      expect(op.sql).toBe(
        'ALTER TABLE "user" ALTER COLUMN "email" TYPE varchar(500) USING "email"::varchar(500)',
      )
    }
  })

  test('nullability flip alone: NOT NULL → NULL emits DROP NOT NULL', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle').nullable()
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('handle', 'character varying', false, 255)],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    if (op.kind === 'alter-column') {
      expect(op.sql).toBe('ALTER TABLE "user" ALTER COLUMN "handle" DROP NOT NULL')
    }
  })

  test('NULL → NOT NULL emits SET NOT NULL', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle') // not nullable
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('handle', 'character varying', true, 255)],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    const op = nonNull(result.operations[0])
    if (op.kind === 'alter-column') {
      expect(op.sql).toBe('ALTER TABLE "user" ALTER COLUMN "handle" SET NOT NULL')
    }
  })

  test('type + nullability change together produce one multi-statement op', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle').max(500).nullable()
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('handle', 'character varying', false, 255)],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    if (op.kind === 'alter-column') {
      expect(op.sql).toBe(
        'ALTER TABLE "user" ALTER COLUMN "handle" TYPE varchar(500) USING "handle"::varchar(500);\n' +
          'ALTER TABLE "user" ALTER COLUMN "handle" DROP NOT NULL',
      )
    }
  })

  test('text → varchar detected (text-kind ↔ string-kind)', () => {
    const note = defineSchema('note', Archetype.Entity, (t) => {
      t.id()
      t.string('body').max(500)
    })
    const registry = new SchemaRegistry().registerAll([note])
    const snap = snapshot({
      name: 'note',
      columns: [col('id', 'character', false, 26), col('body', 'text', false)],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    const op = nonNull(result.operations[0])
    if (op.kind === 'alter-column') {
      expect(op.from.type).toBe('text')
      expect(op.to.type).toBe('varchar(500)')
    }
  })

  test('decimal precision/scale change detected', () => {
    const product = defineSchema('product', Archetype.Entity, (t) => {
      t.id()
      t.decimal('price', 12, 4)
    })
    const registry = new SchemaRegistry().registerAll([product])
    const snap = snapshot({
      name: 'product',
      columns: [
        col('id', 'character', false, 26),
        col('price', 'numeric', false, null, { numericPrecision: 10, numericScale: 2 }),
      ],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    if (op.kind === 'alter-column') {
      expect(op.from.type).toBe('numeric(10, 2)')
      expect(op.to.type).toBe('numeric(12, 4)')
      expect(op.sql).toContain('TYPE numeric(12, 4)')
    }
  })

  test('timestamp tz change detected', () => {
    const evt = defineSchema('evt', Archetype.Entity, (t) => {
      t.id()
      t.timestamp('at', { withTimezone: false })
    })
    const registry = new SchemaRegistry().registerAll([evt])
    const snap = snapshot({
      name: 'evt',
      columns: [col('id', 'character', false, 26), col('at', 'timestamp with time zone', false)],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    const op = nonNull(result.operations[0])
    if (op.kind === 'alter-column') {
      expect(op.from.type).toBe('timestamptz')
      expect(op.to.type).toBe('timestamp')
    }
  })

  test('bigSerial schema field matches bigint live column (no drift)', () => {
    // bigserial is a CREATE-TABLE macro; information_schema reports it as
    // bigint. The canonicalizer collapses both, so no spurious alter.
    const evt = defineSchema('evt', Archetype.Entity, (t) => {
      t.id()
      t.bigSerial('n')
    })
    const registry = new SchemaRegistry().registerAll([evt])
    const snap = snapshot({
      name: 'evt',
      columns: [col('id', 'character', false, 26), col('n', 'bigint', false)],
    })
    expect(diffSchemas(registry, snap, { allowAlter: true }).operations).toEqual([])
  })

  test('no op when type matches exactly (varchar(320) ↔ character varying + 320)', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(320)
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('email', 'character varying', false, 320)],
    })
    expect(diffSchemas(registry, snap, { allowAlter: true }).operations).toEqual([])
  })

  test('alter ops come after add-column ops', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(500) // existing column, drifted
      t.string('handle').nullable() // new column
    })
    const registry = new SchemaRegistry().registerAll([user])
    const snap = snapshot({
      name: 'user',
      columns: [col('id', 'character', false, 26), col('email', 'character varying', false, 255)],
    })
    const result = diffSchemas(registry, snap, { allowAlter: true })
    expect(result.operations.map((o) => o.kind)).toEqual(['add-column', 'alter-column'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// generateMigration — allowAlter flows through; down() reverses to `from`
// ─────────────────────────────────────────────────────────────────────────────

describe('generateMigration — allowAlter', () => {
  test('allowAlter flows through to the diff engine', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(500)
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
      {
        table_name: 'user',
        column_name: 'email',
        data_type: 'character varying',
        character_maximum_length: 255,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const generated = nonNull(await generateMigration({ registry, db, allowAlter: true }))
    expect(generated.diff.operations.map((o) => o.kind)).toEqual(['alter-column'])
  })

  test('down() reverts to the captured `from` state', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(500).nullable()
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
      {
        table_name: 'user',
        column_name: 'email',
        data_type: 'character varying',
        character_maximum_length: 255,
        is_nullable: 'NO',
        column_default: null,
      },
    ]
    const generated = nonNull(await generateMigration({ registry, db, allowAlter: true }))
    const runDb = new FakeExecutor()
    await generated.migration.down(runDb)
    expect(runDb.executed).toHaveLength(1)
    expect(nonNull(runDb.executed[0]).sql).toBe(
      'ALTER TABLE "user" ALTER COLUMN "email" TYPE varchar(255) USING "email"::varchar(255);\n' +
        'ALTER TABLE "user" ALTER COLUMN "email" SET NOT NULL',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Relations through the migration pipeline
//
// Sanity-check that the new relation-builder forms produce the same DDL the
// long-hand `t.foreign(...)` form does, and that the diff generator wires
// belongsTo's auto-FK + belongsToMany's pivot table the way an integration
// test would expect.
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration generation — t.belongsTo', () => {
  test('one-call form emits an FK column identical to the explicit t.foreign(...) form', async () => {
    // Long-hand: explicit FK + manual relation.
    const explicitPost = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.string('title')
      t.foreign('user_id').to('user')
      t.belongsTo('user', { foreignKey: 'user_id', as: 'author' })
    })
    // Short-hand: belongsTo creates both.
    const combinedPost = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.string('title')
      t.belongsTo('user', { as: 'author' })
    })

    const userSchema = defineSchema('user', Archetype.Entity, (t) => t.id())
    const explicitReg = new SchemaRegistry().registerAll([userSchema, explicitPost])
    const combinedReg = new SchemaRegistry().registerAll([userSchema, combinedPost])

    const explicitDb = new FakeExecutor()
    const combinedDb = new FakeExecutor()
    const explicitMig = nonNull(await generateMigration({ registry: explicitReg, db: explicitDb }))
    const combinedMig = nonNull(await generateMigration({ registry: combinedReg, db: combinedDb }))

    const explicitRun = new FakeExecutor()
    const combinedRun = new FakeExecutor()
    await explicitMig.migration.up(explicitRun)
    await combinedMig.migration.up(combinedRun)

    // Same SQL → same DDL — the two forms are interchangeable from the
    // migration generator's point of view.
    expect(combinedRun.executed.map((e) => e.sql)).toEqual(
      explicitRun.executed.map((e) => e.sql),
    )
  })

  test('add-column op fires when belongsTo is added to an existing table', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.string('title')
      t.belongsTo(user, { as: 'author' }) // adds user_id + relation
    })
    const registry = new SchemaRegistry().registerAll([user, post])

    // DB has an older shape of `post` — no user_id yet. user table already exists.
    const result = diffSchemas(
      registry,
      snapshot(
        { name: 'user', columns: [col('id', 'character', false, 26)] },
        {
          name: 'post',
          columns: [
            col('id', 'character', false, 26),
            col('title', 'character varying', false, 255),
          ],
        },
      ),
    )
    expect(result.operations).toHaveLength(1)
    const op = nonNull(result.operations[0])
    expect(op.kind).toBe('add-column')
    if (op.kind === 'add-column') {
      expect(op.schemaName).toBe('post')
      expect(op.columnName).toBe('user_id')
      // SQL emits the FK column as `reference` — char(26) for ULID PK + FK constraint.
      expect(op.sql).toContain('"user_id"')
      expect(op.sql).toContain('REFERENCES "user"')
    }
  })

  test('string target → topological order still puts the parent before the child', () => {
    // userSchema declared FIRST without knowing about postSchema yet.
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.hasMany('post', { foreignKey: 'user_id', as: 'posts' }) // string target
    })
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.belongsTo('user', { as: 'author' }) // string target → user_id FK
    })
    // Register in the WRONG order to make the topological sort earn its keep.
    const registry = new SchemaRegistry().registerAll([post, user])
    const result = diffSchemas(registry, snapshot())
    const creates = result.operations
      .filter((op) => op.kind === 'create-table')
      .map((op) => op.schemaName)
    expect(creates).toEqual(['user', 'post'])
  })
})

describe('Migration generation — t.belongsToMany', () => {
  test('relation declaration alone adds no columns to the owning schema', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').unique()
      t.belongsToMany('role', {
        pivot: 'user_role',
        parentKey: 'user_id',
        targetKey: 'role_id',
        as: 'roles',
      })
    })

    // No `role`, no `user_role` in the registry on purpose — we're only
    // checking the OWNING schema's column set is unchanged by the relation
    // declaration (the pivot lives in its own defineSchema).
    expect(user.fields.map((f) => f.name)).toEqual(['id', 'email'])
  })

  test('the pivot schema generates a join table with two FK columns', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').unique()
      t.belongsToMany('role', {
        pivot: 'user_role',
        parentKey: 'user_id',
        targetKey: 'role_id',
        as: 'roles',
      })
    })
    const role = defineSchema('role', Archetype.Entity, (t) => {
      t.id()
      t.string('name').unique()
    })
    // Pivot is a normal schema; both FK columns belong to the pivot.
    const userRole = defineSchema('user_role', Archetype.Entity, (t) => {
      t.id()
      t.belongsTo(user, { foreignKey: 'user_id', as: 'user' })
      t.belongsTo(role, { foreignKey: 'role_id', as: 'role' })
    })

    const registry = new SchemaRegistry().registerAll([user, role, userRole])
    const db = new FakeExecutor()
    const result = nonNull(await generateMigration({ registry, db }))
    const run = new FakeExecutor()
    await result.migration.up(run)

    const pivotCreate = run.executed.find((e) => /CREATE TABLE "user_role"/.test(e.sql))
    expect(pivotCreate).toBeDefined()
    expect(pivotCreate?.sql).toContain('"user_id"')
    expect(pivotCreate?.sql).toContain('"role_id"')
    expect(pivotCreate?.sql).toContain('REFERENCES "user"')
    expect(pivotCreate?.sql).toContain('REFERENCES "role"')

    // Topological order: pivot must come AFTER both endpoints.
    const creates = run.executed
      .map((e) => e.sql)
      .filter((s) => s.startsWith('CREATE TABLE'))
      .map((s) => /CREATE TABLE "([^"]+)"/.exec(s)?.[1])
    const userIdx = creates.indexOf('user')
    const roleIdx = creates.indexOf('role')
    const pivotIdx = creates.indexOf('user_role')
    expect(pivotIdx).toBeGreaterThan(userIdx)
    expect(pivotIdx).toBeGreaterThan(roleIdx)
  })
})

describe('Migration generation — t.hasOne / t.hasMany', () => {
  test('hasOne / hasMany add NO columns to the parent (FK lives on the child)', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email')
      t.hasOne('profile', { foreignKey: 'user_id' })
      t.hasMany('post', { foreignKey: 'user_id', as: 'posts' })
    })
    expect(user.fields.map((f) => f.name)).toEqual(['id', 'email'])
    // Relations are recorded; columns are not.
    expect(user.relations.map((r) => r.kind).sort()).toEqual(['hasMany', 'hasOne'])
  })

  test('the child schema carries the FK column via belongsTo — generated DDL is symmetric', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.hasOne('profile', { foreignKey: 'user_id' })
    })
    const profile = defineSchema('profile', Archetype.Entity, (t) => {
      t.id()
      t.string('bio')
      t.belongsTo('user', { foreignKey: 'user_id', as: 'user', onDelete: 'cascade' })
    })

    const registry = new SchemaRegistry().registerAll([user, profile])
    const db = new FakeExecutor()
    const result = nonNull(await generateMigration({ registry, db }))
    const run = new FakeExecutor()
    await result.migration.up(run)

    const profileCreate = run.executed.find((e) => /CREATE TABLE "profile"/.test(e.sql))
    expect(profileCreate?.sql).toContain('"user_id"')
    expect(profileCreate?.sql).toContain('REFERENCES "user"')
    expect(profileCreate?.sql).toContain('ON DELETE CASCADE')
  })
})
