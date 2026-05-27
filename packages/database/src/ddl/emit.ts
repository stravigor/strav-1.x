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
 */
export function emitCreateTable(schema: Schema, opts: EmitOptions = {}): EmittedDdl {
  const cols = schema.fields.map((f) => columnDefinition(f, opts.registry))
  const head = opts.ifExists
    ? `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema.name)}`
    : `CREATE TABLE ${quoteIdent(schema.name)}`
  return {
    sql: `${head} (\n  ${cols.join(',\n  ')}\n)`,
  }
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

  const parts: string[] = [quoteIdent(field.name), sqlTypeFor(field, registry)]

  // PRIMARY KEY implies NOT NULL + UNIQUE — don't re-emit the implications.
  if (isPk) {
    parts.push('PRIMARY KEY')
  } else {
    if (!field.nullable) parts.push('NOT NULL')
    if (field.unique) parts.push('UNIQUE')
  }

  if (field.hasDefault) {
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
