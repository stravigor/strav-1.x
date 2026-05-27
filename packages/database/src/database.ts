/**
 * `Database` — the application's connection-pool handle.
 *
 * Implemented on top of `Bun.SQL` (Bun's built-in Postgres driver). The
 * higher layers (migrations, schema registry, future Repository / query
 * builder) interact via the `Database` interface — anything that satisfies
 * `query` / `queryOne` / `execute` / `transaction` / `close` plugs in.
 * That keeps the migration runner testable without spinning up Postgres
 * (see `tests/database/in_memory_database.ts`).
 *
 * The wrapper is intentionally thin:
 *   - `query<T>(sql, params?)` — returns rows (array).
 *   - `queryOne<T>(sql, params?)` — first row or `null`.
 *   - `execute(sql, params?)` — returns affected-row count for DML, or
 *     `0` for DDL / statements that don't report a count.
 *   - `transaction<T>(fn)` — runs `fn` in a transaction; commits on
 *     fulfilment, rolls back on throw.
 *   - `close({ timeout? })` — graceful shutdown; the provider calls this.
 *   - `raw()` — escape hatch returning the underlying `Bun.SQL` for cases
 *     (CTEs, vendor-specific features) the wrapper doesn't cover yet.
 *
 * Query builder, repository pattern, RLS scoping ship in follow-up cuts.
 */

import { SQL } from 'bun'

// ─── Public interface (so tests can stub) ────────────────────────────────────

export interface DatabaseExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  queryOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>
  execute(sql: string, params?: readonly unknown[]): Promise<number>
}

export interface Database extends DatabaseExecutor {
  transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>
  close(options?: { timeout?: number }): Promise<void>
  /** Escape hatch — the underlying `Bun.SQL`. Use for CTEs / vendor features. */
  raw(): SQL
}

export interface PostgresDatabaseOptions {
  /** Postgres URL, e.g. `postgres://user:pass@host:5432/db`. */
  url: string
  /** Idle-connection timeout (seconds). */
  idleTimeout?: number
  /** Max pool size. */
  max?: number
}

// ─── PostgresDatabase ────────────────────────────────────────────────────────

export class PostgresDatabase implements Database {
  private readonly sql: SQL

  constructor(options: PostgresDatabaseOptions) {
    const ctorOpts: Record<string, unknown> = {}
    if (options.idleTimeout !== undefined) ctorOpts.idleTimeout = options.idleTimeout
    if (options.max !== undefined) ctorOpts.max = options.max
    this.sql = new SQL(options.url, ctorOpts as never)
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const rows = await this.sql.unsafe(sql, params as unknown[])
    return (rows ?? []) as T[]
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = (await this.sql.unsafe(sql, params as unknown[])) as unknown as
      | { count?: number; affectedRows?: number; length?: number }
      | undefined
    if (!result) return 0
    if (typeof result.count === 'number') return result.count
    if (typeof result.affectedRows === 'number') return result.affectedRows
    if (typeof result.length === 'number') return result.length
    return 0
  }

  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.sql.begin(async (txSql) => {
      const txExecutor: DatabaseExecutor = {
        query: async <U = Record<string, unknown>>(s: string, p: readonly unknown[] = []) =>
          (await txSql.unsafe(s, p as unknown[])) as U[],
        queryOne: async <U = Record<string, unknown>>(s: string, p: readonly unknown[] = []) => {
          const rows = (await txSql.unsafe(s, p as unknown[])) as U[]
          return rows[0] ?? null
        },
        execute: async (s: string, p: readonly unknown[] = []) => {
          const r = (await txSql.unsafe(s, p as unknown[])) as unknown as
            | { count?: number; length?: number }
            | undefined
          if (!r) return 0
          if (typeof r.count === 'number') return r.count
          if (typeof r.length === 'number') return r.length
          return 0
        },
      }
      return fn(txExecutor)
    }) as Promise<T>
  }

  close(options?: { timeout?: number }): Promise<void> {
    return this.sql.close(options)
  }

  raw(): SQL {
    return this.sql
  }
}
