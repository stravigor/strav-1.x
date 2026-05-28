/**
 * Diff engine — compares registered Schemas against the live DB snapshot
 * and produces an ordered list of forward operations.
 *
 * V1 (additive) detects new tables + new columns. V2 (this file) adds
 * destructive ops behind explicit opt-ins:
 *   - `allowDrop: true` enables DropTable + DropColumn emission for
 *     entities in the DB but not in the registry.
 *   - `renames: { tables, columns }` converts what would otherwise look
 *     like a drop+add into a rename op. Apps declare which renames
 *     happened — diff alone can't tell.
 *   - `allowAlter: true` enables `alter-column` emission for type and
 *     nullability drift on existing columns. The forward SQL uses
 *     `USING "col"::newtype`, which works for any cast Postgres knows
 *     about — incompatible casts surface a Postgres error at execution
 *     time rather than at diff time. Default value changes are NOT
 *     detected; defaults round-trip through `information_schema` as
 *     serialized fragments (`'foo'::text`, `nextval(...)`) that can't
 *     be cleanly compared against literal schema defaults.
 *
 * Operation ordering:
 *   1. `rename-table` ops first — must precede any reference resolution.
 *   2. `rename-column` ops — table identity is set; column identity
 *      becomes correct before any further work.
 *   3. `create-table` ops, topologically sorted by FK refs.
 *   4. `add-column` ops, after create-table.
 *   5. `alter-column` ops, after add-column (a newly-added column can't
 *      be altered the same pass; alters only target columns that already
 *      existed pre-migration).
 *   6. `drop-column` ops, after alterations.
 *   7. `drop-table` ops LAST, in reverse-topological order — drop the
 *      dependents before their targets so FK constraints don't block.
 *
 * Cycle detection: if two registered schemas reference each other AND
 * both are missing in the DB, no single CREATE TABLE order satisfies
 * both. V1 throws; apps break the cycle by making one reference
 * nullable, or land both tables in separate migrations.
 */

import {
  canonicalDbSqlType,
  canonicalSchemaSqlType,
  emitAddColumn,
  emitCreateTable,
  emitDropTable,
} from '../ddl/index.ts'
import { quoteIdent } from '../orm/sql_emitter.ts'
import type { Schema, SchemaField } from '../schema/types.ts'
import type { SchemaRegistry } from '../schema_registry.ts'
import type { ColumnInfo, DbSnapshot } from './inspect.ts'

export type DiffOperation =
  | {
      kind: 'create-table'
      schemaName: string
      schema: Schema
      sql: string
    }
  | {
      kind: 'add-column'
      schemaName: string
      columnName: string
      sql: string
    }
  | {
      kind: 'drop-table'
      tableName: string
      sql: string
    }
  | {
      kind: 'drop-column'
      tableName: string
      columnName: string
      sql: string
    }
  | {
      kind: 'rename-table'
      from: string
      to: string
      sql: string
    }
  | {
      kind: 'rename-column'
      tableName: string
      from: string
      to: string
      sql: string
    }
  | {
      kind: 'alter-column'
      tableName: string
      columnName: string
      /** What's currently in the live DB. Captured so down() can revert. */
      from: AlterColumnState
      /** What the registered schema wants. */
      to: AlterColumnState
      sql: string
    }

/** Snapshot of the diffable column attributes captured by an `alter-column` op. */
export interface AlterColumnState {
  /** Canonical SQL type, e.g. `varchar(255)`, `numeric(10, 2)`, `timestamptz`. */
  type: string
  nullable: boolean
}

export interface DiffResult {
  operations: DiffOperation[]
  /**
   * Tables in the DB the registry doesn't know about — including those NOT
   * dropped because `allowDrop` was off. Always reported, even when drops
   * are emitted, so apps can audit what the diff considered destructive.
   */
  unknownTables: string[]
}

/**
 * Rename mappings to apply BEFORE drop detection. Apps declare these
 * explicitly because diff alone can't tell "rename" from "drop+add".
 *
 * - `tables`: { oldTableName: newTableName }
 * - `columns`: { schemaName: { oldColumnName: newColumnName } }
 *   (Keyed by the SCHEMA name, i.e., the NEW table name — after any
 *   table rename has been applied.)
 */
export interface DiffRenames {
  tables?: Readonly<Record<string, string>>
  columns?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface DiffOptions {
  /**
   * Emit `drop-table` / `drop-column` ops for entities in the DB but not
   * in the registry. Default `false` — drops are dangerous and opt-in.
   * When off, unknowns are still reported in `result.unknownTables` for
   * visibility.
   */
  allowDrop?: boolean
  /**
   * Emit `alter-column` ops for type / nullability drift on existing
   * columns. Default `false` — ALTERs can rewrite the whole table and
   * may need backfill thought, so they're opt-in. Forward SQL uses
   * `USING "col"::newtype`; incompatible casts surface at execution time
   * with the standard Postgres error.
   */
  allowAlter?: boolean
  /**
   * Explicit rename mappings, applied before drop detection. See
   * `DiffRenames`.
   */
  renames?: DiffRenames
}

/**
 * Compute the diff. `registry` is the desired state; `snapshot` is the
 * actual state. Returned operations carry the SQL strings already
 * emitted by the DDL helpers, so the migration runner just executes
 * them in order.
 */
export function diffSchemas(
  registry: SchemaRegistry,
  snapshot: DbSnapshot,
  options: DiffOptions = {},
): DiffResult {
  const operations: DiffOperation[] = []
  const registered = registry.all()
  const renames = normalizeRenames(options.renames)

  // ─── Pass 0: rename ops + apply to the snapshot for downstream passes ──────
  for (const [from, to] of renames.tables) {
    operations.push({
      kind: 'rename-table',
      from,
      to,
      sql: `ALTER TABLE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`,
    })
  }
  const renamedSnapshot = applyTableRenames(snapshot, renames.tables)

  for (const [tableName, columnRenames] of renames.columns) {
    for (const [from, to] of columnRenames) {
      operations.push({
        kind: 'rename-column',
        tableName,
        from,
        to,
        sql: `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`,
      })
    }
  }
  const finalSnapshot = applyColumnRenames(renamedSnapshot, renames.columns)

  // ─── Pass 1: which schemas need creating, which need column additions ───────
  //              also collect alter candidates (existing column, drifted type/null).
  const toCreate: Schema[] = []
  const columnAdditions: Array<{ schema: Schema; column: string }> = []
  const columnAlters: Array<{
    schema: Schema
    field: SchemaField
    liveColumn: ColumnInfo
  }> = []
  for (const schema of registered) {
    const live = finalSnapshot.tables.get(schema.name)
    if (!live) {
      toCreate.push(schema)
      continue
    }
    const liveColumnsByName = new Map(live.columns.map((c) => [c.name, c] as const))
    for (const field of schema.fields) {
      const liveCol = liveColumnsByName.get(field.name)
      if (!liveCol) {
        columnAdditions.push({ schema, column: field.name })
        continue
      }
      if (hasColumnDrift(field, liveCol, registry)) {
        columnAlters.push({ schema, field, liveColumn: liveCol })
      }
    }
  }

  // ─── Pass 2: topologically order CREATE TABLE ops by FK references ──────────
  const ordered = topologicalSort(toCreate, new Set(toCreate.map((s) => s.name)))
  for (const schema of ordered) {
    operations.push({
      kind: 'create-table',
      schemaName: schema.name,
      schema,
      sql: emitCreateTable(schema, { registry }).sql,
    })
  }

  // ─── Pass 3: AddColumn ops after all CreateTable ops ────────────────────────
  for (const { schema, column } of columnAdditions) {
    operations.push({
      kind: 'add-column',
      schemaName: schema.name,
      columnName: column,
      sql: emitAddColumn(schema, column, { registry }).sql,
    })
  }

  // ─── Pass 4: AlterColumn ops (gated by allowAlter) ──────────────────────────
  if (options.allowAlter) {
    for (const { schema, field, liveColumn } of columnAlters) {
      const op = buildAlterColumnOp(schema.name, field, liveColumn, registry)
      if (op) operations.push(op)
    }
  }

  // ─── Pass 5 + 6: drops (gated by allowDrop) + unknownTables reporting ──────
  const knownNames = new Set(registered.map((s) => s.name))
  const unknownTables: string[] = []

  // Columns to drop: present in DB on a known table but not on the schema.
  const columnDrops: Array<{ tableName: string; columnName: string }> = []
  for (const schema of registered) {
    const live = finalSnapshot.tables.get(schema.name)
    if (!live) continue
    const schemaCols = new Set(schema.fields.map((f) => f.name))
    for (const col of live.columns) {
      if (!schemaCols.has(col.name)) {
        columnDrops.push({ tableName: schema.name, columnName: col.name })
      }
    }
  }
  if (options.allowDrop) {
    for (const { tableName, columnName } of columnDrops) {
      operations.push({
        kind: 'drop-column',
        tableName,
        columnName,
        sql: `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(columnName)}`,
      })
    }
  }

  // Tables to drop: in DB but not in registry.
  const droppableTables: string[] = []
  for (const [name] of finalSnapshot.tables) {
    if (!knownNames.has(name)) {
      unknownTables.push(name)
      droppableTables.push(name)
    }
  }
  if (options.allowDrop) {
    // Reverse-sorted by FK dependency would be ideal; we don't have FK
    // graph info on dropped tables, so emit alphabetically. Apps with
    // dependent drops should add `ON DELETE CASCADE` to their FKs or
    // run multiple migrations.
    droppableTables.sort().reverse()
    for (const name of droppableTables) {
      operations.push({
        kind: 'drop-table',
        tableName: name,
        sql: emitDropTable(name).sql,
      })
    }
  }

  return { operations, unknownTables }
}

/**
 * Topological sort: for any schema referencing another schema that's
 * also in the to-create set, the target comes first. References to
 * schemas NOT in to-create (already exist in DB, or external) impose
 * no ordering constraint — the target is already there.
 *
 * Standard DFS-with-temp-mark cycle detection. Throws on cycle.
 */
function topologicalSort(schemas: readonly Schema[], inSet: Set<string>): Schema[] {
  const byName = new Map(schemas.map((s) => [s.name, s] as const))
  const sorted: Schema[] = []
  const visited = new Set<string>()
  const onStack = new Set<string>()

  function visit(schema: Schema, stack: string[]): void {
    if (visited.has(schema.name)) return
    if (onStack.has(schema.name)) {
      throw new Error(
        `diffSchemas: circular FK between ${[...stack, schema.name].join(' → ')}. ` +
          'Break the cycle by making one reference nullable and adding it via a follow-up migration, ' +
          'or land both tables in separate migrations with the FK added explicitly.',
      )
    }
    onStack.add(schema.name)
    for (const field of schema.fields) {
      if (field.kind !== 'reference') continue
      if (!inSet.has(field.references)) continue
      const target = byName.get(field.references)
      if (target) visit(target, [...stack, schema.name])
    }
    onStack.delete(schema.name)
    visited.add(schema.name)
    sorted.push(schema)
  }

  for (const schema of schemas) visit(schema, [])
  return sorted
}

/** Normalize the renames option into Maps for stable iteration. */
function normalizeRenames(renames: DiffRenames | undefined): {
  tables: Map<string, string>
  columns: Map<string, Map<string, string>>
} {
  const tables = new Map<string, string>(Object.entries(renames?.tables ?? {}))
  const columns = new Map<string, Map<string, string>>()
  for (const [schemaName, colMap] of Object.entries(renames?.columns ?? {})) {
    columns.set(schemaName, new Map(Object.entries(colMap)))
  }
  return { tables, columns }
}

/** Apply table renames to a snapshot — returns a new snapshot. */
function applyTableRenames(snapshot: DbSnapshot, renames: ReadonlyMap<string, string>): DbSnapshot {
  if (renames.size === 0) return snapshot
  const next = new Map(snapshot.tables)
  for (const [from, to] of renames) {
    const table = next.get(from)
    if (!table) continue
    next.delete(from)
    next.set(to, { ...table, name: to })
  }
  return { tables: next }
}

/**
 * True when an existing column's canonical type OR nullability has drifted
 * from the schema field. Identity-kind fields (id / uuid / bigSerial /
 * tenantedBigSerial) compare like any other — the canonicalizer collapses
 * `bigserial` → `bigint` so the synthetic sequence default doesn't trip a
 * false-positive against the underlying `bigint` info_schema reports.
 */
function hasColumnDrift(
  field: SchemaField,
  liveCol: ColumnInfo,
  registry: SchemaRegistry,
): boolean {
  const schemaType = canonicalSchemaSqlType(field, registry)
  const dbType = canonicalDbSqlType(liveCol)
  if (schemaType !== dbType) return true
  if (field.nullable !== liveCol.nullable) return true
  return false
}

/**
 * Build the alter-column op for one drifted field. Combines TYPE + SET/DROP
 * NOT NULL into a single multi-statement SQL string joined by `;\n` — the
 * runner forwards the whole string to `db.execute()`, which handles
 * multi-statement SQL without further splitting.
 */
function buildAlterColumnOp(
  tableName: string,
  field: SchemaField,
  liveCol: ColumnInfo,
  registry: SchemaRegistry,
): DiffOperation | null {
  const from: AlterColumnState = {
    type: canonicalDbSqlType(liveCol),
    nullable: liveCol.nullable,
  }
  const to: AlterColumnState = {
    type: canonicalSchemaSqlType(field, registry),
    nullable: field.nullable,
  }
  const statements = alterColumnStatements(tableName, field.name, from, to)
  if (statements.length === 0) return null
  return {
    kind: 'alter-column',
    tableName,
    columnName: field.name,
    from,
    to,
    sql: statements.join(';\n'),
  }
}

/**
 * Forward statements that transform `from` into `to`. Empty when the two
 * are identical. Order: TYPE change first (so the column is in the right
 * shape before nullability constraints are applied).
 */
function alterColumnStatements(
  tableName: string,
  columnName: string,
  from: AlterColumnState,
  to: AlterColumnState,
): string[] {
  const stmts: string[] = []
  const table = quoteIdent(tableName)
  const column = quoteIdent(columnName)
  if (from.type !== to.type) {
    stmts.push(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${to.type} USING ${column}::${to.type}`,
    )
  }
  if (from.nullable !== to.nullable) {
    stmts.push(
      to.nullable
        ? `ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`
        : `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
    )
  }
  return stmts
}

/**
 * Public counterpart of `alterColumnStatements` — exposed so the migration
 * down() can compute the reverse SQL without re-introspecting the DB.
 */
export function emitAlterColumnSql(
  tableName: string,
  columnName: string,
  from: AlterColumnState,
  to: AlterColumnState,
): string {
  return alterColumnStatements(tableName, columnName, from, to).join(';\n')
}

/** Apply column renames to a snapshot — returns a new snapshot. */
function applyColumnRenames(
  snapshot: DbSnapshot,
  renames: ReadonlyMap<string, ReadonlyMap<string, string>>,
): DbSnapshot {
  if (renames.size === 0) return snapshot
  const next = new Map(snapshot.tables)
  for (const [tableName, colRenames] of renames) {
    const table = next.get(tableName)
    if (!table) continue
    const renamedCols = table.columns.map((c) => {
      const newName = colRenames.get(c.name)
      return newName ? { ...c, name: newName } : c
    })
    next.set(tableName, { ...table, columns: renamedCols })
  }
  return { tables: next }
}
