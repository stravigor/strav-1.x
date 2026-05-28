/**
 * `generateMigration` — the public entry point of the diff slice.
 *
 * Reads the live DB, computes the diff against the registered Schemas,
 * and returns a ready-to-register `Migration` object (or `null` when
 * the DB is already up to date — calling code typically asserts on
 * the null to detect the no-op case).
 *
 * The returned Migration's `up()` runs the forward ops in declared
 * order; `down()` runs best-effort inverses (DROP TABLE for each
 * created table in reverse order; DROP COLUMN for each added column).
 * Down is best-effort because the diff itself is additive — apps that
 * need a full rollback path should write the migration by hand.
 *
 * Today this returns a `Migration` *object*. Writing the migration to
 * a file (`database/migrations/YYYYMMDDHHMMSS_auto_diff.ts`) lands with
 * the CLI command (`bun strav make:migration`) — needs `@strav/cli`.
 */

import type { DatabaseExecutor } from '../database.ts'
import { emitDropTable } from '../ddl/index.ts'
import type { Migration } from '../migrations/index.ts'
import { quoteIdent } from '../orm/sql_emitter.ts'
import type { SchemaRegistry } from '../schema_registry.ts'
import { type DiffOptions, type DiffResult, diffSchemas } from './diff.ts'
import { inspectDatabase } from './inspect.ts'

export interface GenerateMigrationOptions extends DiffOptions {
  /** The catalog of desired schemas. */
  registry: SchemaRegistry
  /** Live DB connection (or any DatabaseExecutor — e.g., transaction-scoped). */
  db: DatabaseExecutor
  /** Migration name. Default `YYYYMMDDHHMMSS_auto_diff`. */
  name?: string
  /** Override `now` for deterministic naming in tests. */
  now?: Date
}

export interface GeneratedMigration {
  migration: Migration
  diff: DiffResult
}

/**
 * Returns `null` when the DB is already in sync with the registry — no
 * migration needed. Otherwise returns the migration + the diff that
 * produced it (the diff is useful for previewing what would run).
 */
export async function generateMigration(
  options: GenerateMigrationOptions,
): Promise<GeneratedMigration | null> {
  const snapshot = await inspectDatabase(options.db)
  const diff = diffSchemas(options.registry, snapshot, {
    allowDrop: options.allowDrop,
    renames: options.renames,
  })
  if (diff.operations.length === 0) return null

  const name = options.name ?? defaultMigrationName(options.now ?? new Date())

  const migration: Migration = {
    name,
    async up(db) {
      for (const op of diff.operations) {
        await db.execute(op.sql)
      }
    },
    async down(db) {
      // Best-effort inverses in REVERSE op order.
      //
      // - `add-column` → `DROP COLUMN IF EXISTS`
      // - `create-table` → `DROP TABLE IF EXISTS`
      // - `rename-*` → reverse the rename
      //
      // Drops (`drop-table` / `drop-column`) DO NOT have a clean inverse —
      // we'd need the schema definition for the dropped entity, which the
      // diff process explicitly discarded. The inverse is a no-op with a
      // logged comment; apps that need to undo a destructive migration
      // recreate the dropped entity by hand.
      for (let i = diff.operations.length - 1; i >= 0; i--) {
        const op = diff.operations[i]
        if (!op) continue
        switch (op.kind) {
          case 'add-column':
            await db.execute(
              `ALTER TABLE ${quoteIdent(op.schemaName)} DROP COLUMN IF EXISTS ${quoteIdent(op.columnName)}`,
            )
            break
          case 'create-table':
            await db.execute(emitDropTable(op.schemaName, { ifExists: true }).sql)
            break
          case 'rename-table':
            await db.execute(`ALTER TABLE ${quoteIdent(op.to)} RENAME TO ${quoteIdent(op.from)}`)
            break
          case 'rename-column':
            await db.execute(
              `ALTER TABLE ${quoteIdent(op.tableName)} RENAME COLUMN ${quoteIdent(op.to)} TO ${quoteIdent(op.from)}`,
            )
            break
          // `drop-table` / `drop-column` have no clean inverse — the diff
          // discarded the original schema definition. No-op intentionally.
          case 'drop-table':
          case 'drop-column':
            break
        }
      }
    },
  }

  return { migration, diff }
}

/**
 * Default migration name. `YYYYMMDDHHMMSS_auto_diff`. UTC so multiple
 * developers' clocks don't collide.
 */
function defaultMigrationName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('')
  return `${stamp}_auto_diff`
}
