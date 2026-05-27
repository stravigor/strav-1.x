/**
 * `InMemoryDatabase` — a Database stub for unit testing the migration runner.
 *
 * Doesn't simulate SQL parsing — it only knows enough about the queries the
 * migration runner emits to behave correctly:
 *   - `CREATE TABLE IF NOT EXISTS _strav_migrations …` → creates the in-memory table.
 *   - `INSERT INTO _strav_migrations (name, batch) VALUES ($1, $2)` → appends a row.
 *   - `DELETE FROM _strav_migrations WHERE name = $1` → removes a row.
 *   - `SELECT name, batch, applied_at FROM _strav_migrations ORDER BY name ASC` → reads.
 *   - `SELECT COALESCE(MAX(batch), 0) AS max FROM _strav_migrations` → max batch.
 *
 * Each migration's `up()` / `down()` runs through `transaction()` which calls
 * the callback with an executor that delegates to the same in-memory store
 * (and additionally records every SQL string the migration emitted, so tests
 * can assert "the migration tried to run CREATE TABLE foo").
 *
 * Not a general-purpose Postgres simulator; pure-Postgres integration tests
 * are out of scope for this package's unit suite and belong with CI.
 */

import type { Database, DatabaseExecutor } from '../src/database.ts'

interface AppliedRow {
  name: string
  batch: number
  applied_at: Date
}

export class InMemoryDatabase implements Database {
  /** All non-tracking SQL the runner / migrations emitted, in order. */
  readonly executedSql: string[] = []

  private trackingTableExists = false
  private applied: AppliedRow[] = []
  /** When set, `up()` / `down()` should throw to simulate a failure. */
  failNext: string | undefined

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const normalized = sql.trim()
    if (/SELECT name, batch, applied_at FROM _strav_migrations/i.test(normalized)) {
      return [...this.applied].sort((a, b) => a.name.localeCompare(b.name)) as unknown as T[]
    }
    if (/SELECT COALESCE\(MAX\(batch\), 0\) AS max/i.test(normalized)) {
      const max = this.applied.reduce((m, r) => Math.max(m, r.batch), 0)
      return [{ max }] as unknown as T[]
    }
    // Generic record — tests can drive arbitrary reads if they want.
    this.executedSql.push(normalized)
    if (params.length > 0) this.executedSql.push(`-- params: ${JSON.stringify(params)}`)
    return []
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const normalized = sql.trim()
    if (/CREATE TABLE IF NOT EXISTS _strav_migrations/i.test(normalized)) {
      this.trackingTableExists = true
      return 0
    }
    if (/INSERT INTO _strav_migrations/i.test(normalized)) {
      this.assertTracking()
      const [name, batch] = params as [string, number]
      this.applied.push({ name, batch, applied_at: new Date() })
      return 1
    }
    if (/DELETE FROM _strav_migrations WHERE name/i.test(normalized)) {
      this.assertTracking()
      const [name] = params as [string]
      const before = this.applied.length
      this.applied = this.applied.filter((r) => r.name !== name)
      return before - this.applied.length
    }
    // Anything else (CREATE TABLE foo, ALTER TABLE bar, …) is recorded so
    // tests can assert what a migration's `up()` emitted.
    this.executedSql.push(normalized)
    if (params.length > 0) this.executedSql.push(`-- params: ${JSON.stringify(params)}`)
    return 0
  }

  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    // Sufficiently realistic: thrown errors propagate; the runner's tracking
    // insert is in the same transaction as the migration's body, so a throw
    // means the row never made it. We simulate by relying on the runner's
    // ordering (insert AFTER the migration body).
    return fn({
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: async (s, p) => {
        if (this.failNext && this.failNext === s) {
          this.failNext = undefined
          throw new Error(`InMemoryDatabase: simulated failure for "${s.slice(0, 40)}…"`)
        }
        return this.execute(s, p)
      },
    })
  }

  async close(): Promise<void> {
    // no-op
  }

  raw(): never {
    throw new Error('InMemoryDatabase: raw() is not implemented.')
  }

  // ─── Test helpers ──────────────────────────────────────────────────────────

  appliedNames(): readonly string[] {
    return this.applied.map((r) => r.name)
  }

  reset(): void {
    this.executedSql.length = 0
    this.applied = []
    this.trackingTableExists = false
  }

  private assertTracking(): void {
    if (!this.trackingTableExists) {
      throw new Error(
        'InMemoryDatabase: tracking table not created — runner must call ensureTrackingTable() first.',
      )
    }
  }
}
