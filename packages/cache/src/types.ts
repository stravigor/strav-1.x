/**
 * Public types for `@strav/cache`.
 *
 * The Cache surface is small on purpose — drivers implement a tight
 * set of primitive ops, and the abstract base composes higher-level
 * patterns (`remember`, `rememberForever`) on top so every driver
 * behaves identically there.
 */

/**
 * TTL accepted by `put` / `add` / `remember` / `lock`. Three forms:
 *
 *   - `'10m'` / `'1h'` / `'45s'` — short-form string. Suffixes:
 *     `s` (seconds), `m` (minutes), `h` (hours), `d` (days).
 *   - `300` — number, interpreted as seconds.
 *   - `null` / `undefined` — no expiry (caller takes responsibility for
 *     invalidation). Use sparingly; entries persist until the process
 *     restarts (Memory) or you `forget` them (Postgres).
 *
 * The parser is forgiving — whitespace allowed, case-insensitive.
 * `'1.5m'` is NOT supported; integer values only.
 */
export type CacheTtl = string | number | null | undefined

/**
 * Distributed lock — atomic "only one caller holds this name".
 *
 * Acquired locks expire after their TTL — set it long enough that the
 * holder finishes its work, short enough that a crashed holder doesn't
 * block forever. The release path uses an owner token so a slow
 * caller whose lock already expired can't release someone else's
 * newer lock.
 */
export interface CacheLock {
  /** The name passed to `cache.lock(name, ttl)`. */
  readonly name: string
  /**
   * Try to acquire the lock once. Returns `true` if held, `false`
   * if another caller already holds it (or this caller already
   * acquired + didn't release).
   */
  acquire(): Promise<boolean>
  /**
   * Release the lock IF the current caller holds it. No-op if the
   * lock expired or someone else holds it now. Returns `true` if
   * the release actually fired, `false` otherwise.
   */
  release(): Promise<boolean>
  /**
   * Poll `acquire()` until success or `timeoutMs` elapses. On
   * success runs `fn` then `release()`s. On timeout throws
   * `CacheLockTimeoutError`. The wait interval defaults to 200ms.
   */
  block<T>(timeoutMs: number, fn: () => Promise<T> | T): Promise<T>
}

/**
 * Tagged-cache namespace.
 *
 * Keys put through a `TaggedCache` are associated with one or more
 * tags; `flush()` invalidates every key carrying any of these tags.
 *
 * Use case: "every cache entry that references the user with id N"
 * gets tagged `user:N`, and a single `cache.tags(['user:N']).flush()`
 * on user-update drops all of them — without you tracking which keys
 * those were.
 */
export interface TaggedCache {
  readonly tags: readonly string[]
  put(key: string, value: unknown, ttl?: CacheTtl): Promise<void>
  get<T = unknown>(key: string, fallback?: T | null): Promise<T | null>
  forget(key: string): Promise<boolean>
  /**
   * Drop every key carrying any of this namespace's tags. Returns the
   * number of keys removed.
   */
  flush(): Promise<number>
}

/**
 * Driver-internal cache record — what's persisted on the wire.
 * Not exported from the package barrel; the abstract base uses it
 * to share the `remember` implementation across drivers.
 */
export interface CacheEntry<T = unknown> {
  value: T
  expiresAt: number | null // unix ms; null = forever
}
