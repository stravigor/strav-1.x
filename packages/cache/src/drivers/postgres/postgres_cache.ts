/**
 * `PostgresCache` — cross-process cache backed by three tables.
 *
 * Atomic ops are atomic at the DB layer:
 *
 *   - `add` uses `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at <=
 *     now() RETURNING xmax::int = 0` to distinguish "first insert"
 *     from "updated an expired row" (both succeed) and "row was
 *     fresh, conflict skipped" (fails). Concurrent callers see
 *     consistent semantics — exactly one wins.
 *   - `increment` / `decrement` use a single `INSERT ... ON CONFLICT
 *     DO UPDATE` that flips the value via `(data::text::numeric)`.
 *     Concurrent increments serialize at the row lock; the final
 *     value reflects every increment.
 *   - Lock `acquire` uses the same upsert pattern against
 *     `strav_cache_locks`. Lock release scopes on `name + owner` so
 *     a slow caller can't release someone else's newer lock.
 *
 * Bun's `SQL` driver returns jsonb columns as strings (no
 * auto-hydration). The driver `JSON.parse`s on the way out — same
 * pattern as `@strav/broadcast`'s Postgres driver.
 */

import { ulid } from '@strav/kernel'
import { Cache } from '../../cache.ts'
import { CacheDriverError, CacheLockTimeoutError } from '../../cache_error.ts'
import { parseTtl } from '../../ttl.ts'
import type { CacheLock, CacheTtl, TaggedCache } from '../../types.ts'

/**
 * Minimal Database surface — declared inline so the package's
 * runtime dep on `@strav/database` stays an *optional* peer.
 */
export interface PostgresCacheDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  execute(sql: string, params?: readonly unknown[]): Promise<number>
}

export interface PostgresCacheOptions {
  db: PostgresCacheDatabase
  /**
   * How often to sweep expired rows. Set to `0` to disable (apps with
   * Postgres pre-12 or aggressive table partitioning may want to
   * handle GC themselves). Default `60_000` (one minute).
   */
  cleanupIntervalMs?: number
}

const TABLE = '"strav_cache"'
const LOCK_TABLE = '"strav_cache_locks"'
const TAGS_TABLE = '"strav_cache_tags"'

export class PostgresCache extends Cache {
  private readonly db: PostgresCacheDatabase
  private readonly cleanupIntervalMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(options: PostgresCacheOptions) {
    super()
    this.db = options.db
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000
    this.startCleanupLoop()
  }

  // ─── Core primitives ───────────────────────────────────────────────────────

  override async get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    // Bun.SQL auto-hydrates jsonb scalars (numbers, booleans, strings,
    // null) to native JS types and returns objects/arrays as their
    // JSON-encoded text representation. So:
    //   - non-string → return as-is.
    //   - string that parses as JSON → use the parsed result (object).
    //   - string that doesn't parse → it's a string-scalar we got back
    //     unwrapped — return the string itself.
    const rows = await this.q<{ data: unknown }>(
      `SELECT "data" FROM ${TABLE}
       WHERE "key" = $1 AND ("expires_at" IS NULL OR "expires_at" > now())`,
      [key],
    )
    const row = rows[0]
    if (row === undefined || row.data === null) return fallback
    if (typeof row.data !== 'string') return row.data as T
    try {
      return JSON.parse(row.data) as T
    } catch {
      return row.data as T
    }
  }

  override async put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    const seconds = parseTtl(ttl)
    await this.x(
      `INSERT INTO ${TABLE} ("key", "data", "expires_at")
       VALUES ($1, ($2::text)::jsonb, ${this.ttlSqlExpr(seconds)})
       ON CONFLICT ("key") DO UPDATE
       SET "data" = EXCLUDED."data", "expires_at" = EXCLUDED."expires_at"`,
      [key, JSON.stringify(value)],
    )
  }

  override async has(key: string): Promise<boolean> {
    const rows = await this.q<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ${TABLE}
         WHERE "key" = $1 AND ("expires_at" IS NULL OR "expires_at" > now())
       ) AS "exists"`,
      [key],
    )
    return rows[0]?.exists === true
  }

  override async forget(key: string): Promise<boolean> {
    const affected = await this.x(`DELETE FROM ${TABLE} WHERE "key" = $1`, [key])
    return affected > 0
  }

  override async flush(): Promise<void> {
    // Truncate cascades through the FK to strav_cache_tags. Locks are
    // a separate table and survive flush — matches MemoryCache.
    await this.x(`TRUNCATE ${TABLE} CASCADE`)
  }

  override async add(key: string, value: unknown, ttl: CacheTtl): Promise<boolean> {
    const seconds = parseTtl(ttl)
    // The `WHERE` clause on the UPDATE branch means we only overwrite
    // an existing row when it has expired. A fresh row skips the
    // UPDATE; the INSERT path runs only when no row exists at all. So
    // RETURNING is non-empty iff we successfully stored.
    const rows = await this.q<{ stored: number }>(
      `INSERT INTO ${TABLE} ("key", "data", "expires_at")
       VALUES ($1, ($2::text)::jsonb, ${this.ttlSqlExpr(seconds)})
       ON CONFLICT ("key") DO UPDATE
       SET "data" = EXCLUDED."data", "expires_at" = EXCLUDED."expires_at"
       WHERE ${TABLE}."expires_at" IS NOT NULL AND ${TABLE}."expires_at" <= now()
       RETURNING 1 AS "stored"`,
      [key, JSON.stringify(value)],
    )
    return rows.length > 0
  }

  override async increment(key: string, by = 1): Promise<number> {
    return this.adjust(key, by)
  }

  override async decrement(key: string, by = 1): Promise<number> {
    return this.adjust(key, -by)
  }

  override lock(name: string, ttl: CacheTtl): CacheLock {
    return new PostgresCacheLock(this, name, ttl)
  }

  override tags(...tags: string[]): TaggedCache {
    return new PostgresTaggedCache(this, tags)
  }

  override async close(): Promise<void> {
    this.closed = true
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  // ─── Maintenance ──────────────────────────────────────────────────────────

  /** Run one cleanup pass. Returns the number of expired rows deleted. */
  async sweepOnce(): Promise<number> {
    return this.x(
      `DELETE FROM ${TABLE}
       WHERE "expires_at" IS NOT NULL AND "expires_at" <= now()`,
    )
  }

  /** Sweep the lock table — different schema, run alongside `sweepOnce`. */
  async sweepLocksOnce(): Promise<number> {
    return this.x(`DELETE FROM ${LOCK_TABLE} WHERE "expires_at" <= now()`)
  }

  // ─── Lock + tag internals (exposed to the wrapper classes) ─────────────────

  /** @internal */
  async _tryAcquireLock(name: string, ttl: CacheTtl): Promise<string | undefined> {
    const seconds = parseTtl(ttl)
    if (seconds === null) {
      throw new CacheDriverError('PostgresCache.lock: TTL must be set — no "forever" locks.', {
        context: { name },
      })
    }
    const owner = ulid()
    const rows = await this.q<{ owner: string }>(
      `INSERT INTO ${LOCK_TABLE} ("name", "owner", "expires_at")
       VALUES ($1, $2, now() + ($3::text || ' seconds')::interval)
       ON CONFLICT ("name") DO UPDATE
       SET "owner" = EXCLUDED."owner", "expires_at" = EXCLUDED."expires_at"
       WHERE ${LOCK_TABLE}."expires_at" <= now()
       RETURNING "owner"`,
      [name, owner, String(seconds)],
    )
    if (rows[0]?.owner === owner) return owner
    return undefined
  }

  /** @internal */
  async _releaseLock(name: string, owner: string): Promise<boolean> {
    const affected = await this.x(`DELETE FROM ${LOCK_TABLE} WHERE "name" = $1 AND "owner" = $2`, [
      name,
      owner,
    ])
    return affected > 0
  }

  /** @internal */
  async _putWithTags(
    key: string,
    value: unknown,
    ttl: CacheTtl,
    tags: readonly string[],
  ): Promise<void> {
    // Two writes — putting the cache entry, then re-syncing its tags.
    // No transaction wrapper: a partial failure leaves stale tag rows,
    // but the worst-case impact is "next flush() catches them" since
    // the tag rows alone don't keep entries alive. Adding a tx is
    // worth it later if app traffic shows the partial-write being a
    // real problem.
    await this.put(key, value, ttl)
    await this.x(`DELETE FROM ${TAGS_TABLE} WHERE "key" = $1`, [key])
    if (tags.length === 0) return
    // Bun.SQL doesn't transparently bind JS arrays to Postgres `text[]`
    // parameters — pass the Postgres array literal as a string and let
    // the server cast it.
    await this.x(
      `INSERT INTO ${TAGS_TABLE} ("key", "tag")
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [key, toPgTextArray(tags)],
    )
  }

  /** @internal */
  async _flushTags(tags: readonly string[]): Promise<number> {
    if (tags.length === 0) return 0
    const affected = await this.x(
      `DELETE FROM ${TABLE}
       WHERE "key" IN (
         SELECT DISTINCT "key" FROM ${TAGS_TABLE} WHERE "tag" = ANY($1::text[])
       )`,
      [toPgTextArray(tags)],
    )
    return affected
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async adjust(key: string, delta: number): Promise<number> {
    // INSERT or UPDATE in one statement.
    // - If the key is missing, store `delta` with no TTL.
    // - If the key is present and unexpired, add `delta` to the
    //   existing numeric value (carrying jsonb through ::text::numeric
    //   so non-numeric stored values fail loudly rather than silently
    //   reset).
    // - If the key is present but expired, reset to `delta` and clear
    //   the TTL — treat expired rows as missing.
    const rows = await this.q<{ value: string | number }>(
      `INSERT INTO ${TABLE} ("key", "data", "expires_at")
       VALUES ($1, to_jsonb($2::numeric), NULL)
       ON CONFLICT ("key") DO UPDATE
       SET "data" = to_jsonb(
         CASE
           WHEN ${TABLE}."expires_at" IS NOT NULL AND ${TABLE}."expires_at" <= now()
             THEN $2::numeric
           ELSE ${TABLE}."data"::text::numeric + $2::numeric
         END
       ),
       "expires_at" = CASE
         WHEN ${TABLE}."expires_at" IS NOT NULL AND ${TABLE}."expires_at" <= now()
           THEN NULL
         ELSE ${TABLE}."expires_at"
       END
       RETURNING "data"::text::numeric AS "value"`,
      [key, delta],
    )
    const value = rows[0]?.value
    if (value === undefined) {
      throw new CacheDriverError(
        `PostgresCache.${delta >= 0 ? 'increment' : 'decrement'}: no value returned (driver bug).`,
        { context: { key, delta } },
      )
    }
    return Number(value)
  }

  private ttlSqlExpr(seconds: number | null): string {
    if (seconds === null) return 'NULL'
    return `now() + interval '${seconds} seconds'`
  }

  private startCleanupLoop(): void {
    if (this.cleanupIntervalMs <= 0) return
    this.cleanupTimer = setInterval(() => {
      void this.sweepOnce().catch(() => {
        // Same rationale as the broadcast poller: transient DB
        // failures shouldn't tear the cache down. Apps wire DB-driver
        // logging if they need visibility into sweep failures.
      })
      void this.sweepLocksOnce().catch(() => {})
    }, this.cleanupIntervalMs)
    // Don't let the timer keep the process alive on its own.
    this.cleanupTimer.unref?.()
  }

  private async q<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    if (this.closed) throw new CacheDriverError('PostgresCache is closed.')
    return this.db.query<T>(sql, params)
  }

  private async x(sql: string, params: readonly unknown[] = []): Promise<number> {
    if (this.closed) throw new CacheDriverError('PostgresCache is closed.')
    return this.db.execute(sql, params)
  }
}

class PostgresCacheLock implements CacheLock {
  private owner: string | undefined

  constructor(
    private readonly cache: PostgresCache,
    readonly name: string,
    private readonly ttl: CacheTtl,
  ) {}

  async acquire(): Promise<boolean> {
    if (this.owner !== undefined) return false
    const token = await this.cache._tryAcquireLock(this.name, this.ttl)
    if (token === undefined) return false
    this.owner = token
    return true
  }

  async release(): Promise<boolean> {
    if (this.owner === undefined) return false
    const released = await this.cache._releaseLock(this.name, this.owner)
    this.owner = undefined
    return released
  }

  async block<T>(timeoutMs: number, fn: () => Promise<T> | T): Promise<T> {
    if (timeoutMs < 0 || !Number.isFinite(timeoutMs)) {
      throw new Error(
        `CacheLock.block: timeoutMs must be a non-negative finite number; got: ${timeoutMs}`,
      )
    }
    const deadline = Date.now() + timeoutMs
    const pollIntervalMs = 200
    while (true) {
      if (await this.acquire()) {
        try {
          return await fn()
        } finally {
          await this.release()
        }
      }
      if (Date.now() >= deadline) {
        throw new CacheLockTimeoutError(
          `CacheLock "${this.name}" not acquired within ${timeoutMs}ms.`,
          { context: { lock: this.name, timeoutMs } },
        )
      }
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs))
    }
  }
}

class PostgresTaggedCache implements TaggedCache {
  constructor(
    private readonly cache: PostgresCache,
    readonly tags: readonly string[],
  ) {}

  put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    return this.cache._putWithTags(key, value, ttl, this.tags)
  }

  get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    return this.cache.get<T>(key, fallback)
  }

  forget(key: string): Promise<boolean> {
    return this.cache.forget(key)
  }

  flush(): Promise<number> {
    return this.cache._flushTags(this.tags)
  }
}

/**
 * Format a JS string array as a Postgres array literal so it can ride
 * a single text parameter and the server can cast it via `$N::text[]`.
 * Escapes embedded `"` and `\\` per the Postgres array literal spec —
 * commas inside quoted items are fine.
 */
function toPgTextArray(items: readonly string[]): string {
  const escaped = items.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${escaped.join(',')}}`
}
