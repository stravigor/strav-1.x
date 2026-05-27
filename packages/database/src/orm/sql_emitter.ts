/**
 * Schema-driven SQL emission.
 *
 * Centralizes the rules that every CRUD path needs:
 *   - identifier quoting (Postgres double-quotes for safety against keyword
 *     collisions and case-sensitive names)
 *   - parameter placeholders ($1, $2, …)
 *   - ULID auto-generation when an `id` field isn't supplied on insert
 *   - `updated_at` auto-bump on update when the schema declared it
 *   - `RETURNING *` so callers can hydrate the just-inserted/updated row
 *     in one round-trip
 *
 * Returns `{ sql, params }` ready to hand to `Database.execute / query /
 * queryOne`. The QueryBuilder and Repository compose these helpers; tests
 * assert the strings.
 */

import { ulid } from '@strav/kernel'
import type { Schema, SchemaField } from '../schema/types.ts'

export interface EmittedSql {
  sql: string
  params: unknown[]
}

/** Quote a Postgres identifier — double-quote and double-up embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Build `$N` placeholder; bumps a shared index. */
function nextPlaceholder(index: { value: number }): string {
  index.value += 1
  return `$${index.value}`
}

/** Snapshot of all column names in declaration order (used for SELECT *). */
export function selectColumnList(schema: Schema): string {
  return schema.fields.map((f) => quoteIdent(f.name)).join(', ')
}

/**
 * INSERT statement with auto-id (ULID) and auto-timestamps where the schema
 * defined `timestamps()`. Returns `{ sql, params }` ready to execute.
 *
 * Behavior:
 *   - If the schema declares an `id` field and `attrs.id` is absent → mint a
 *     fresh ULID and add it to params.
 *   - If the schema declares `created_at` / `updated_at` and they're absent
 *     from attrs → don't bind them; let the DB's `DEFAULT now()` fire. This
 *     keeps the columns DB-driven (one source of time truth).
 *   - All other present-in-attrs columns are bound positionally.
 */
export function emitInsert(schema: Schema, attrs: Readonly<Record<string, unknown>>): EmittedSql {
  const cols: string[] = []
  const placeholders: string[] = []
  const params: unknown[] = []
  const index = { value: 0 }

  // Auto-generate id when the schema declares one and the caller didn't.
  const idField = schema.fields.find(
    (f) => f.name === 'id' && (f.kind === 'id' || f.kind === 'uuid'),
  )
  if (idField && attrs.id === undefined) {
    cols.push(quoteIdent('id'))
    placeholders.push(nextPlaceholder(index))
    params.push(idField.kind === 'id' ? ulid() : crypto.randomUUID())
  }

  for (const field of schema.fields) {
    if (field.name === 'id' && idField && attrs.id === undefined) continue
    const value = attrs[field.name]
    if (value === undefined) continue
    cols.push(quoteIdent(field.name))
    placeholders.push(nextPlaceholder(index))
    params.push(value)
  }

  if (cols.length === 0) {
    // Edge case: every field has a DB default. Emit a DEFAULT VALUES insert.
    return {
      sql: `INSERT INTO ${quoteIdent(schema.name)} DEFAULT VALUES RETURNING *`,
      params,
    }
  }

  const sql = `INSERT INTO ${quoteIdent(schema.name)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`
  return { sql, params }
}

/**
 * UPDATE by id. Bumps `updated_at` automatically when the schema declared
 * it and the caller didn't supply a value.
 */
export function emitUpdateById(
  schema: Schema,
  id: unknown,
  changes: Readonly<Record<string, unknown>>,
): EmittedSql {
  const sets: string[] = []
  const params: unknown[] = []
  const index = { value: 0 }

  const hasUpdatedAt = schema.fields.some((f) => f.name === 'updated_at' && f.kind === 'timestamp')

  let userSuppliedChanges = 0
  for (const field of schema.fields) {
    if (field.name === 'id') continue
    const value = changes[field.name]
    if (value === undefined) continue
    sets.push(`${quoteIdent(field.name)} = ${nextPlaceholder(index)}`)
    params.push(value)
    userSuppliedChanges++
  }

  // An update with literally no caller-supplied changes is a programmer error
  // — emitting "SET updated_at = now()" alone would be silently touching a row
  // no one asked to touch.
  if (userSuppliedChanges === 0) {
    throw new Error(`emitUpdateById("${schema.name}"): no changes to apply.`)
  }

  if (hasUpdatedAt && changes.updated_at === undefined) {
    sets.push(`${quoteIdent('updated_at')} = now()`)
  }

  const wherePlaceholder = nextPlaceholder(index)
  params.push(id)
  const sql = `UPDATE ${quoteIdent(schema.name)} SET ${sets.join(', ')} WHERE ${quoteIdent('id')} = ${wherePlaceholder} RETURNING *`
  return { sql, params }
}

/** DELETE by id. Returns affected-row count via `Database.execute`. */
export function emitDeleteById(schema: Schema, id: unknown): EmittedSql {
  return {
    sql: `DELETE FROM ${quoteIdent(schema.name)} WHERE ${quoteIdent('id')} = $1`,
    params: [id],
  }
}

/** SELECT one row by id. */
export function emitFindById(schema: Schema, id: unknown): EmittedSql {
  return {
    sql: `SELECT ${selectColumnList(schema)} FROM ${quoteIdent(schema.name)} WHERE ${quoteIdent('id')} = $1 LIMIT 1`,
    params: [id],
  }
}

/** SELECT many rows by id list. */
export function emitFindMany(schema: Schema, ids: readonly unknown[]): EmittedSql {
  if (ids.length === 0) {
    // Match a degenerate (always-false) condition so the query is still valid SQL.
    return {
      sql: `SELECT ${selectColumnList(schema)} FROM ${quoteIdent(schema.name)} WHERE FALSE`,
      params: [],
    }
  }
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  return {
    sql: `SELECT ${selectColumnList(schema)} FROM ${quoteIdent(schema.name)} WHERE ${quoteIdent('id')} IN (${placeholders})`,
    params: [...ids],
  }
}

/** Helper — does the schema have a field with this name and kind? */
export function hasField(schema: Schema, name: string, kind?: SchemaField['kind']): boolean {
  return schema.fields.some((f) => f.name === name && (!kind || f.kind === kind))
}
