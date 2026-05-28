/**
 * Diff engine — compares registered Schemas against the live DB snapshot
 * and produces an ordered list of forward operations.
 *
 * V1 detects only *additive* changes:
 *   - Table is in the registry, not in the DB           → CreateTable op
 *   - Column is on a schema, not on the existing table  → AddColumn op
 *
 * V1 ignores (each is its own follow-up slice):
 *   - Tables present in the DB but not in the registry — destructive;
 *     blindly dropping would lose data
 *   - Columns present in the DB but not on the schema — same reason
 *   - Type / nullability / default differences on existing columns —
 *     ALTER COLUMN semantics need backfill design
 *
 * Operation ordering:
 *   1. All `create-table` ops first, in topological order of references
 *      (a table that references another comes AFTER its target).
 *   2. All `add-column` ops, in schema declaration order, AFTER all
 *      create-table ops (so a new column with a REFERENCES clause has
 *      its target table already in place).
 *
 * Cycle detection: if two registered schemas reference each other AND
 * both are missing in the DB, no single CREATE TABLE order satisfies
 * both. V1 throws with a clear error; apps break the cycle by making
 * one FK nullable (and adding it via a later migration) or by using
 * DEFERRABLE constraints by hand. Resolving cycles automatically lands
 * with the multi-step migration generator.
 */

import { emitAddColumn, emitCreateTable } from '../ddl/index.ts'
import type { Schema } from '../schema/types.ts'
import type { SchemaRegistry } from '../schema_registry.ts'
import type { DbSnapshot } from './inspect.ts'

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

export interface DiffResult {
  operations: DiffOperation[]
  /** Tables already in the DB the registry doesn't know about. Informational only — V1 doesn't touch them. */
  unknownTables: string[]
}

/**
 * Compute the diff. `registry` is the desired state; `snapshot` is the
 * actual state. Returned operations carry the SQL strings already
 * emitted by the DDL helpers, so the migration runner just executes
 * them in order.
 */
export function diffSchemas(registry: SchemaRegistry, snapshot: DbSnapshot): DiffResult {
  const operations: DiffOperation[] = []
  const registered = registry.all()

  // ─── Pass 1: which schemas need creating, which need column additions ───────
  const toCreate: Schema[] = []
  const columnAdditions: Array<{ schema: Schema; column: string }> = []
  for (const schema of registered) {
    const live = snapshot.tables.get(schema.name)
    if (!live) {
      toCreate.push(schema)
      continue
    }
    const liveColumns = new Set(live.columns.map((c) => c.name))
    for (const field of schema.fields) {
      if (!liveColumns.has(field.name)) {
        columnAdditions.push({ schema, column: field.name })
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

  // ─── Informational: tables the registry doesn't know about ────────────────
  const knownNames = new Set(registered.map((s) => s.name))
  const unknownTables: string[] = []
  for (const [name] of snapshot.tables) {
    if (!knownNames.has(name)) unknownTables.push(name)
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
