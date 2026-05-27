/**
 * Migration contracts — what the runner expects and what it returns.
 *
 * A `Migration` is just `{ name, up(db), down(db) }`. Apps write them as
 * one file per change in `database/migrations/` and register them on the
 * runner (manually for now; auto-discovery via `Bun.Glob` lands later).
 *
 * The `name` is the migration's identity in the `_strav_migrations` tracking
 * table. Convention: `YYYYMMDDHHMMSS_short_description` (lexicographically
 * sortable). The runner enforces alphabetical order, so timestamps in the
 * name are how you control execution order.
 */

import type { DatabaseExecutor } from '../database.ts'

export interface Migration {
  /** Stable identity recorded in `_strav_migrations`. */
  readonly name: string
  /** Apply the change. Receives a transaction-scoped executor when called by `migrate()`. */
  up(db: DatabaseExecutor): Promise<void>
  /** Roll the change back. Optional — migrations that can't be reversed throw. */
  down(db: DatabaseExecutor): Promise<void>
}

/** One row of the tracking table. */
export interface AppliedMigration {
  name: string
  /** All migrations applied in a single `migrate()` call share a batch number. */
  batch: number
  applied_at: Date
}

/** Result of `runner.status()`. */
export interface MigrationStatus {
  applied: readonly AppliedMigration[]
  pending: readonly string[]
}
