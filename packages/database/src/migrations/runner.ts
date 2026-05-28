/**
 * `MigrationRunner` — applies / rolls back / inspects migrations.
 *
 * Tracking table `_strav_migrations`:
 *   - `name` (text PK)
 *   - `batch` (int, NOT NULL) — all migrations applied in one `migrate()` call share a batch
 *   - `applied_at` (timestamptz, NOT NULL DEFAULT now())
 *
 * Order: alphabetical by `name`. Apps follow the
 * `YYYYMMDDHHMMSS_description` convention so the order is also a timeline.
 *
 * Each `up()` / `down()` runs in its own transaction. The whole `migrate()`
 * call is NOT one transaction — Postgres DDL inside a single big
 * transaction would lock the entire schema; per-migration transactions
 * give you a known-good state to recover from.
 *
 * `rollback()` is the inverse of one batch — the most-recently-applied set
 * comes off in reverse order.
 */

import type { Database } from '../database.ts'
import type { AppliedMigration, Migration, MigrationStatus } from './types.ts'

const TRACKING_TABLE = '_strav_migrations'

const CREATE_TRACKING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
    name        text        PRIMARY KEY,
    batch       integer     NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`.trim()

export interface MigrationRunResult {
  applied: readonly string[]
  batch: number
}

export interface MigrationRollbackResult {
  rolled_back: readonly string[]
  batch: number
}

export class MigrationRunner {
  private readonly migrations: Migration[] = []

  constructor(private readonly db: Database) {}

  /** Register one migration. Throws if the name is already registered. */
  register(migration: Migration): this {
    if (this.migrations.some((m) => m.name === migration.name)) {
      throw new Error(`MigrationRunner: migration "${migration.name}" is already registered.`)
    }
    this.migrations.push(migration)
    return this
  }

  /** Register many at once. Order doesn't matter — execution is alphabetical by name. */
  registerAll(migrations: readonly Migration[]): this {
    for (const m of migrations) this.register(m)
    return this
  }

  /**
   * Auto-discover migrations by glob pattern. For each matched file the
   * runner does a dynamic `import(...)` and walks every exported value:
   *
   * ```ts
   * await runner.discover('database/migrations/*.ts')
   * ```
   *
   * A value qualifies as a migration when it's an object with a non-empty
   * `name: string` and function-typed `up` + `down`. Files that export
   * nothing migration-shaped are silently skipped — discover() is a
   * low-friction "register everything that looks like a migration" pass.
   *
   * Re-discovering the SAME instance is a no-op; a different instance
   * with the same name will fall through to `register()`'s "already
   * registered" error so duplicates are loud.
   */
  async discover(pattern: string | string[], options: { cwd?: string } = {}): Promise<this> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const cwd = options.cwd ?? process.cwd()
    const files = new Set<string>()
    for (const p of patterns) {
      const glob = new Bun.Glob(p)
      for await (const file of glob.scan({ cwd, absolute: true })) {
        files.add(file)
      }
    }
    for (const file of files) {
      const mod = (await import(file)) as Record<string, unknown>
      for (const value of Object.values(mod)) {
        if (!isMigration(value)) continue
        if (this.migrations.some((m) => m === value)) continue
        this.register(value)
      }
    }
    return this
  }

  /** Read-only inventory of every migration the runner knows about, sorted. */
  list(): readonly Migration[] {
    return [...this.migrations].sort(byName)
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Idempotent — ensures the tracking table exists. Called by `migrate` / `rollback` / `status`. */
  async ensureTrackingTable(): Promise<void> {
    await this.db.execute(CREATE_TRACKING_TABLE_SQL)
  }

  /**
   * Apply every pending migration in alphabetical order. Each runs in its
   * own transaction. Returns the names of migrations that were applied
   * plus the batch number they share.
   *
   * Throws if any migration's `up()` rejects — earlier ones in the same
   * `migrate()` call have already committed (this is intentional; partial
   * progress is recoverable, and DDL doesn't roll back cleanly when batched).
   */
  async migrate(): Promise<MigrationRunResult> {
    await this.ensureTrackingTable()
    const applied = new Set((await this.appliedRows()).map((r) => r.name))
    const pending = this.list().filter((m) => !applied.has(m.name))
    if (pending.length === 0) return { applied: [], batch: await this.nextBatch() }

    const batch = await this.nextBatch()
    const appliedNames: string[] = []
    for (const migration of pending) {
      await this.db.transaction(async (tx) => {
        await migration.up(tx)
        await tx.execute(`INSERT INTO ${TRACKING_TABLE} (name, batch) VALUES ($1, $2)`, [
          migration.name,
          batch,
        ])
      })
      appliedNames.push(migration.name)
    }
    return { applied: appliedNames, batch }
  }

  /**
   * Roll back the most-recently-applied batch. Migrations come off in
   * reverse alphabetical order. Returns the rolled-back names + the batch
   * that was undone (0 when nothing was pending).
   */
  async rollback(): Promise<MigrationRollbackResult> {
    await this.ensureTrackingTable()
    const applied = await this.appliedRows()
    if (applied.length === 0) return { rolled_back: [], batch: 0 }

    const lastBatch = Math.max(...applied.map((r) => r.batch))
    const inBatch = applied
      .filter((r) => r.batch === lastBatch)
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)) // descending

    const rolledBack: string[] = []
    for (const row of inBatch) {
      const migration = this.migrations.find((m) => m.name === row.name)
      if (!migration) {
        // The DB has an applied migration whose code isn't registered.
        // Surface as a hard error — proceeding would leave the tracking
        // table out of sync with reality.
        throw new Error(
          `MigrationRunner: applied migration "${row.name}" is not registered. ` +
            'Register every historical migration before rolling back.',
        )
      }
      await this.db.transaction(async (tx) => {
        await migration.down(tx)
        await tx.execute(`DELETE FROM ${TRACKING_TABLE} WHERE name = $1`, [row.name])
      })
      rolledBack.push(row.name)
    }
    return { rolled_back: rolledBack, batch: lastBatch }
  }

  /** Snapshot of applied + pending migrations — for `bun strav migrate:status`. */
  async status(): Promise<MigrationStatus> {
    await this.ensureTrackingTable()
    const applied = await this.appliedRows()
    const appliedSet = new Set(applied.map((r) => r.name))
    const pending = this.list()
      .map((m) => m.name)
      .filter((n) => !appliedSet.has(n))
    return { applied, pending }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async appliedRows(): Promise<readonly AppliedMigration[]> {
    const rows = await this.db.query<{ name: string; batch: number; applied_at: Date | string }>(
      `SELECT name, batch, applied_at FROM ${TRACKING_TABLE} ORDER BY name ASC`,
    )
    return rows.map((r) => ({
      name: r.name,
      batch: r.batch,
      applied_at: r.applied_at instanceof Date ? r.applied_at : new Date(r.applied_at),
    }))
  }

  private async nextBatch(): Promise<number> {
    const row = await this.db.queryOne<{ max: number | null }>(
      `SELECT COALESCE(MAX(batch), 0) AS max FROM ${TRACKING_TABLE}`,
    )
    return (row?.max ?? 0) + 1
  }
}

function byName(a: Migration, b: Migration): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Type-guard: a value looks like a `Migration`. Used by `discover()`. */
function isMigration(value: unknown): value is Migration {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.up === 'function' &&
    typeof v.down === 'function'
  )
}
