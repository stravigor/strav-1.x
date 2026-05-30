/**
 * `Cache` — the abstract base every driver extends and apps inject
 * via the container.
 *
 * Driver primitives (subclass overrides):
 *
 *   - `get(key)` — returns the stored value or `null`. Expired entries
 *     return `null` AND are removed in passing.
 *   - `put(key, value, ttl?)` — overwrite. `ttl` parsed via `parseTtl`.
 *   - `has(key)` — boolean check.
 *   - `forget(key)` — delete. Returns true if a key was actually
 *     removed.
 *   - `flush()` — clear everything. DEV-mode tool; production code
 *     should prefer scoped invalidation.
 *   - `add(key, value, ttl)` — atomic put-if-absent. Returns true if
 *     stored, false if a value was already there (and unexpired).
 *   - `increment(key, by)` / `decrement(key, by)` — atomic numeric
 *     update. Drivers must guarantee atomicity across concurrent
 *     callers; the Memory driver is fine for single-process dev,
 *     Postgres uses an UPDATE … RETURNING.
 *   - `lock(name, ttl)` — return a `CacheLock` handle. The same `name`
 *     across processes / requests competes for one slot.
 *   - `tags(...tags)` — return a `TaggedCache` namespace.
 *
 * The base provides:
 *
 *   - `remember(key, ttl, fn)` / `rememberForever(key, fn)` — the
 *     "get or compute and cache" pattern. Implemented once on top of
 *     `get` + `put` so every driver behaves identically.
 *   - `close()` — default no-op; drivers override to release pools.
 *
 * Non-abstract on purpose so the class can serve as the container
 * token (`app.singleton(Cache, factory)`). Subclasses MUST override
 * the primitives; the default implementations throw to surface
 * forgotten overrides during development. Same trade-off as
 * `kernel`'s `Logger` and `@strav/broadcast`'s `Broadcaster`.
 */

import type { CacheLock, CacheTtl, TaggedCache } from './types.ts'

export class Cache {
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  get<T = unknown>(key: string, fallback?: T | null): Promise<T | null> {
    throw new Error('Cache.get must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    throw new Error('Cache.put must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  has(key: string): Promise<boolean> {
    throw new Error('Cache.has must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  forget(key: string): Promise<boolean> {
    throw new Error('Cache.forget must be overridden by the driver subclass.')
  }
  flush(): Promise<void> {
    throw new Error('Cache.flush must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  add(key: string, value: unknown, ttl: CacheTtl): Promise<boolean> {
    throw new Error('Cache.add must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  increment(key: string, by = 1): Promise<number> {
    throw new Error('Cache.increment must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  decrement(key: string, by = 1): Promise<number> {
    throw new Error('Cache.decrement must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  lock(name: string, ttl: CacheTtl): CacheLock {
    throw new Error('Cache.lock must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  tags(...tags: string[]): TaggedCache {
    throw new Error('Cache.tags must be overridden by the driver subclass.')
  }

  // ─── Higher-level patterns (driver-agnostic) ───────────────────────────────

  /**
   * "Get this value, or compute and cache it." The most common
   * cache-aside shape — and the one driver-portable code reaches for
   * by default.
   */
  async remember<T>(key: string, ttl: CacheTtl, fn: () => Promise<T> | T): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== null) return cached
    const fresh = await fn()
    await this.put(key, fresh, ttl)
    return fresh
  }

  /** `remember` with no TTL. The entry persists until `forget` / `flush`. */
  rememberForever<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    return this.remember(key, null, fn)
  }

  /** Optional driver-resource cleanup. Default no-op. */
  async close(): Promise<void> {}
}
