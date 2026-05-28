/**
 * DDL emitters — `CREATE TABLE`, `DROP TABLE`, `ADD COLUMN`, `DROP COLUMN`.
 *
 * Schema-driven SQL. The output is auditable: column order matches the
 * schema's declaration order, constraints inline per column, defaults
 * stringified once by a shared serializer.
 *
 * What's NOT here (each lands in a later slice):
 *   - `RENAME TABLE` / `RENAME COLUMN` / `CHANGE COLUMN` — renames need
 *     migration-time identity tracking; type changes need backfill
 *     semantics. Both are richer than a single statement.
 *   - `ADD INDEX` / `DROP INDEX` — schemas don't declare indexes; explicit
 *     index ops belong to the migration builder DSL (`m.addIndex(...)`).
 *   - `ADD FOREIGN KEY` / `DROP FOREIGN KEY` standalone — references
 *     inline into CREATE TABLE / ADD COLUMN already; standalone FK ops
 *     are a migration-DSL concern.
 *   - Tenancy plumbing — RLS policies, tenant-FK column injection on
 *     `tenanted: true` schemas, the composite (tenant_id, id) PK. All
 *     deferred to the tenancy slice.
 *
 * Convention: every emitter returns `{ sql }` (no params — DDL doesn't
 * parameterize). Hand to `Database.execute()`.
 */

import { quoteIdent } from '../orm/sql_emitter.ts'
import type { EnumField, ReferenceField, Schema, SchemaField } from '../schema/types.ts'
import type { SchemaRegistry } from '../schema_registry.ts'
import { findPrimaryKey, isPrimaryKeyKind, resolveReferenceTarget, sqlTypeFor } from './sql_type.ts'
import {
  emitRlsForTenanted,
  emitTenantedBigSerialSetup,
  tenantIdColumnField,
  tenantRegistrySchema,
} from './tenancy.ts'

export interface EmittedDdl {
  sql: string
}

export interface EmitOptions {
  /** Required when the schema has reference fields. */
  registry?: SchemaRegistry
  /** Adds `IF NOT EXISTS` (create) / `IF EXISTS` (drop). Default false. */
  ifExists?: boolean
}

/**
 * `CREATE TABLE` for a Schema. Emits one column line per field, in
 * declaration order, with PRIMARY KEY / NOT NULL / UNIQUE / DEFAULT /
 * REFERENCES / CHECK inlined per column.
 *
 * For `tenanted: true` schemas the emitter additionally:
 *   1. Injects a `<tenant_registry>_id` FK column right after the PK
 *      (NOT NULL, ON DELETE CASCADE, type matching the tenant registry's
 *      PK).
 *   2. Appends `ENABLE ROW LEVEL SECURITY` + a tenant-isolation `CREATE
 *      POLICY` statement, joined to the CREATE TABLE with `;\n`.
 * `Database.execute()` handles multi-statement SQL; the runner doesn't
 * need to split.
 */
export function emitCreateTable(schema: Schema, opts: EmitOptions = {}): EmittedDdl {
  const fields = injectTenantColumn(schema, opts.registry)
  const cols = fields.map((f) => columnDefinition(f, opts.registry))
  const head = opts.ifExists
    ? `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema.name)}`
    : `CREATE TABLE ${quoteIdent(schema.name)}`
  const createTable = `${head} (\n  ${cols.join(',\n  ')}\n)`

  if (!schema.tenancy.tenanted) {
    return { sql: createTable }
  }

  const pk = findPrimaryKey(schema)
  const parts: string[] = [createTable]
  if (pk.kind === 'tenantedBigSerial') {
    parts.push(emitTenantedBigSerialSetup(schema, opts.registry))
  }
  parts.push(emitRlsForTenanted(schema, opts.registry))
  return { sql: parts.join(';\n') }
}

/**
 * For tenanted schemas, return the field list with the synthetic
 * `<registry>_id` FK column inserted right after the PK. For everything
 * else, the original field list — non-tenanted output stays byte-
 * identical to pre-tenancy emission.
 */
function injectTenantColumn(
  schema: Schema,
  registry: SchemaRegistry | undefined,
): readonly SchemaField[] {
  if (!schema.tenancy.tenanted) return schema.fields
  const tenantReg = tenantRegistrySchema(registry)
  const tenantCol = tenantIdColumnField(tenantReg)
  // PK first, then the tenant column, then everything else (in declaration
  // order). The PK is always the first PK-kind field in `fields` (the
  // schema builder enforces one identity per schema).
  const pkIndex = schema.fields.findIndex(isPrimaryKeyKind)
  if (pkIndex < 0) {
    throw new Error(
      `emitCreateTable("${schema.name}"): tenanted schema is missing an identity field (t.id() / t.uuid() / etc.).`,
    )
  }
  return [...schema.fields.slice(0, pkIndex + 1), tenantCol, ...schema.fields.slice(pkIndex + 1)]
}

/** `DROP TABLE`. */
export function emitDropTable(name: string, opts: { ifExists?: boolean } = {}): EmittedDdl {
  return {
    sql: opts.ifExists
      ? `DROP TABLE IF EXISTS ${quoteIdent(name)}`
      : `DROP TABLE ${quoteIdent(name)}`,
  }
}

/**
 * `ALTER TABLE … ADD COLUMN`. The new column's full definition is taken
 * from `schema.fields[fieldName]` — the same column-definition logic
 * that CREATE TABLE uses, so the two paths can't drift.
 */
export function emitAddColumn(
  schema: Schema,
  fieldName: string,
  opts: EmitOptions = {},
): EmittedDdl {
  const field = schema.fields.find((f) => f.name === fieldName)
  if (!field) {
    throw new Error(`emitAddColumn("${schema.name}", "${fieldName}"): no such field on the schema.`)
  }
  return {
    sql: `ALTER TABLE ${quoteIdent(schema.name)} ADD COLUMN ${columnDefinition(field, opts.registry)}`,
  }
}

/** `ALTER TABLE … DROP COLUMN`. */
export function emitDropColumn(
  table: string,
  column: string,
  opts: { ifExists?: boolean } = {},
): EmittedDdl {
  const suffix = opts.ifExists ? ' IF EXISTS' : ''
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} DROP COLUMN${suffix} ${quoteIdent(column)}`,
  }
}

/** `ALTER TABLE … RENAME TO …`. */
export function emitRenameTable(from: string, to: string): EmittedDdl {
  return { sql: `ALTER TABLE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}` }
}

/** `ALTER TABLE … RENAME COLUMN … TO …`. */
export function emitRenameColumn(table: string, from: string, to: string): EmittedDdl {
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`,
  }
}

export interface CreateIndexOptions {
  /** Index name. Default `<table>_<col1>[_<col2>]…_idx`. */
  name?: string
  /** Unique index. Default false. */
  unique?: boolean
  /** Partial-index predicate, e.g. `"deleted_at" IS NULL`. */
  where?: string
  /** Access method (`btree` / `gin` / `gist` / `hash` / `brin`). Default `btree`. */
  using?: string
  /** Adds `IF NOT EXISTS`. Default false. */
  ifExists?: boolean
}

/**
 * `CREATE [UNIQUE] INDEX [name] ON "table" USING method (col1, col2) [WHERE …]`.
 *
 * Default name is `<table>_<col1>[_<col2>]…_idx`. Partial unique indexes
 * (the right idiom for soft-delete + unique-on-active-rows) just need
 * `unique: true, where: '"deleted_at" IS NULL'`.
 */
export function emitCreateIndex(
  table: string,
  columns: readonly string[],
  opts: CreateIndexOptions = {},
): EmittedDdl {
  if (columns.length === 0) {
    throw new Error(`emitCreateIndex("${table}"): at least one column is required.`)
  }
  const name = opts.name ?? `${table}_${columns.join('_')}_idx`
  const unique = opts.unique ? 'UNIQUE ' : ''
  const ifNot = opts.ifExists ? 'IF NOT EXISTS ' : ''
  const using = opts.using ? ` USING ${opts.using}` : ''
  const cols = columns.map(quoteIdent).join(', ')
  const where = opts.where ? ` WHERE ${opts.where}` : ''
  return {
    sql: `CREATE ${unique}INDEX ${ifNot}${quoteIdent(name)} ON ${quoteIdent(table)}${using} (${cols})${where}`,
  }
}

/** `DROP INDEX [IF EXISTS] name`. */
export function emitDropIndex(name: string, opts: { ifExists?: boolean } = {}): EmittedDdl {
  return {
    sql: opts.ifExists
      ? `DROP INDEX IF EXISTS ${quoteIdent(name)}`
      : `DROP INDEX ${quoteIdent(name)}`,
  }
}

/**
 * Single column's definition — used by both CREATE TABLE and ADD COLUMN
 * so they emit byte-identical column specs. Exposed publicly for apps
 * that need DDL on bespoke shapes.
 *
 * Layout: `<name> <type> [PRIMARY KEY] [NOT NULL] [UNIQUE] [DEFAULT …]
 *          [REFERENCES …] [CHECK …]`
 */
export function columnDefinition(field: SchemaField, registry?: SchemaRegistry): string {
  const isPk = isPrimaryKeyKind(field)
  // `tenantedBigSerial` gets a composite (tenant_id, id) PRIMARY KEY at
  // the table-constraint level — the inline `PRIMARY KEY` per-column
  // is skipped. The DEFAULT 0 lets callers omit `id` on INSERT; the
  // BEFORE INSERT trigger replaces 0 with the per-tenant next-id.
  const tenantedBigSerial = field.kind === 'tenantedBigSerial'
  const inlinePk = isPk && !tenantedBigSerial

  const parts: string[] = [quoteIdent(field.name), sqlTypeFor(field, registry)]

  // PRIMARY KEY implies NOT NULL + UNIQUE — don't re-emit the implications.
  if (inlinePk) {
    parts.push('PRIMARY KEY')
  } else {
    if (!field.nullable) parts.push('NOT NULL')
    if (field.unique) parts.push('UNIQUE')
  }

  if (tenantedBigSerial) {
    parts.push('DEFAULT 0')
  } else if (field.hasDefault) {
    parts.push(`DEFAULT ${defaultSql(field.default)}`)
  }

  if (field.kind === 'reference') {
    const ref = field as ReferenceField
    const target = resolveReferenceTarget(ref.name, ref.references, registry)
    const targetPk = findPrimaryKey(target)
    parts.push(
      `REFERENCES ${quoteIdent(ref.references)} (${quoteIdent(targetPk.name)}) ON DELETE ${ref.onDelete.toUpperCase()}`,
    )
  }

  if (field.kind === 'enum') {
    const e = field as EnumField
    const list = e.values.map(escapeStringLiteral).join(', ')
    parts.push(`CHECK (${quoteIdent(field.name)} IN (${list}))`)
  }

  return parts.join(' ')
}

/**
 * Serialize a default value as inline SQL. Recognizes `{ sql: '...' }` as
 * a raw-SQL marker so the schema-level `default({ sql: 'now()' })`
 * (the convention `timestamps()` uses) emits `DEFAULT now()` rather
 * than a stringified object.
 *
 * Booleans, numbers, bigints inline directly. Strings single-quote and
 * escape. Everything else (arrays, plain objects) JSON-stringifies and
 * casts to jsonb — apps that want a JSON default write `default([])` or
 * `default({foo: 1})` literally.
 *
 * Null is rare (`DEFAULT NULL` is the implicit default for nullable
 * columns) but supported for completeness.
 */
export function defaultSql(value: unknown): string {
  if (value && typeof value === 'object' && 'sql' in (value as Record<string, unknown>)) {
    return String((value as { sql: unknown }).sql)
  }
  if (value === null) return 'NULL'
  if (typeof value === 'string') return escapeStringLiteral(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return value.toString()
  return `${escapeStringLiteral(JSON.stringify(value))}::jsonb`
}

/** Single-quote a string literal; double-up embedded quotes. */
function escapeStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
