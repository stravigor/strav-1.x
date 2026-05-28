/**
 * Read the live DB's `information_schema` into a structured snapshot the
 * diff engine can compare against the registered Schemas.
 *
 * One round-trip: a single SELECT joins `tables` and `columns` and groups
 * client-side. Skips the framework's own tracking table
 * (`_strav_migrations`) — it's an implementation detail of MigrationRunner
 * and apps shouldn't see it in a diff.
 *
 * What's NOT in the snapshot (each deferred to a follow-up slice):
 *   - **Indexes.** Schemas don't declare indexes; the diff can't decide
 *     between "this is a manual index" vs "this is missing." Lands with
 *     the migration-builder-DSL index ops.
 *   - **Foreign keys / CHECK constraints.** Already inlined in columns
 *     via REFERENCES + CHECK; standalone constraint diffing is its own
 *     concern.
 *   - **Type / nullability / default differences on existing columns.**
 *     V1 only detects MISSING things; alterations need destructive-or-
 *     backfill migration semantics that warrant explicit design.
 */

import type { DatabaseExecutor } from '../database.ts'

const TRACKING_TABLE = '_strav_migrations'

export interface ColumnInfo {
  name: string
  /** Raw `data_type` from information_schema (e.g., 'character varying', 'bigint'). */
  dataType: string
  /** From `character_maximum_length` — only set for varchar / char. */
  maxLength: number | null
  nullable: boolean
  default: string | null
}

export interface TableInfo {
  name: string
  /** Columns in `ordinal_position` order (matches CREATE TABLE declaration order). */
  columns: ColumnInfo[]
}

export interface DbSnapshot {
  /** Keyed by table name. */
  tables: Map<string, TableInfo>
}

interface JoinedRow {
  table_name: string
  column_name: string | null
  data_type: string | null
  character_maximum_length: number | null
  is_nullable: string | null
  column_default: string | null
}

/**
 * Snapshot every user table + its columns in one query. Pass any
 * `DatabaseExecutor` (PostgresDatabase satisfies it). The schema name
 * filter is hard-coded to `'public'` — multi-schema support lands with
 * the multi-tenancy slice.
 */
export async function inspectDatabase(db: DatabaseExecutor): Promise<DbSnapshot> {
  const rows = await db.query<JoinedRow>(
    `SELECT
       t.table_name,
       c.column_name,
       c.data_type,
       c.character_maximum_length,
       c.is_nullable,
       c.column_default
     FROM information_schema.tables t
     LEFT JOIN information_schema.columns c
       ON c.table_schema = t.table_schema AND c.table_name = t.table_name
     WHERE t.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND t.table_name <> $1
     ORDER BY t.table_name, c.ordinal_position`,
    [TRACKING_TABLE],
  )

  const tables = new Map<string, TableInfo>()
  for (const row of rows) {
    let table = tables.get(row.table_name)
    if (!table) {
      table = { name: row.table_name, columns: [] }
      tables.set(row.table_name, table)
    }
    if (row.column_name === null) continue
    table.columns.push({
      name: row.column_name,
      dataType: row.data_type ?? '',
      maxLength: row.character_maximum_length,
      nullable: row.is_nullable === 'YES',
      default: row.column_default,
    })
  }

  return { tables }
}
