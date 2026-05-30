/**
 * `MemoryCache` — in-process cache backed by a single `Map`.
 *
 * Right driver for: dev, tests, per-process caches that don't need
 * cross-process visibility. Wrong driver for: production deployments
 * with more than one node (each node sees its own copy).
 *
 * Atomic ops (`add`, `increment`, `decrement`) are atomic *within
 * this process* — Bun's event loop is single-threaded so no JS-level
 * race exists. Cross-process, you want `PostgresCache`.
 *
 * Locks + tags are first-class here for parity with the Postgres
 * driver, but the lock guarantee is only meaningful in a single
 * process (use Postgres for cross-process mutual exclusion). The tag
 * implementation walks two parallel maps (`key → tag-set`,
 * `tag → key-set`) — cheap because everything is in memory.
 */

import { ulid } from '@strav/kernel'
import { Cache } from '../../cache.ts'
import { CacheLockTimeoutError } from '../../cache_error.ts'
import { ttlToExpiresAt } from '../../ttl.ts'
import type { CacheEntry, CacheLock, CacheTtl, TaggedCache } from '../../types.ts'

export interface MemoryCacheOptions {
  /**
   * Override the clock for deterministic TTL tests. Default `Date.now`.
   */
  now?: () => number
}

export class MemoryCache extends Cache {
  private readonly entries = new Map<string, CacheEntry<unknown>>()
  private readonly keyTags = new Map<string, Set<string>>()
  private readonly tagKeys = new Map<string, Set<string>>()
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>()
  private readonly nowFn: () => number

  constructor(options: MemoryCacheOptions = {}) {
    super()
    this.nowFn = options.now ?? Date.now
  }

  override async get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    const entry = this.entries.get(key)
    if (entry === undefined) return fallback
    if (this.expired(entry)) {
      this.entries.delete(key)
      this.removeKeyFromAllTags(key)
      return fallback
    }
    return entry.value as T
  }

  override async put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    this.entries.set(key, { value, expiresAt: ttlToExpiresAt(ttl, this.nowFn()) })
  }

  override async has(key: string): Promise<boolean> {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    if (this.expired(entry)) {
      this.entries.delete(key)
      this.removeKeyFromAllTags(key)
      return false
    }
    return true
  }

  override async forget(key: string): Promise<boolean> {
    this.removeKeyFromAllTags(key)
    return this.entries.delete(key)
  }

  override async flush(): Promise<void> {
    this.entries.clear()
    this.keyTags.clear()
    this.tagKeys.clear()
    // Active locks aren't cleared — they're a separate concept from
    // cached values, and `flush()` shouldn't surprise a holder by
    // dropping their lock.
  }

  override async add(key: string, value: unknown, ttl: CacheTtl): Promise<boolean> {
    const existing = this.entries.get(key)
    if (existing !== undefined && !this.expired(existing)) return false
    this.entries.set(key, { value, expiresAt: ttlToExpiresAt(ttl, this.nowFn()) })
    return true
  }

  override async increment(key: string, by = 1): Promise<number> {
    return this.adjust(key, by)
  }

  override async decrement(key: string, by = 1): Promise<number> {
    return this.adjust(key, -by)
  }

  override lock(name: string, ttl: CacheTtl): CacheLock {
    return new MemoryCacheLock(this, name, ttl)
  }

  override tags(...tags: string[]): TaggedCache {
    return new MemoryTaggedCache(this, tags)
  }

  // ─── Diagnostics / helpers ─────────────────────────────────────────────────

  /** Total entry count, including expired-but-not-yet-evicted rows. */
  size(): number {
    return this.entries.size
  }

  // ─── Driver-internals exposed to the lock + tagged wrappers ────────────────

  /** @internal */
  _now(): number {
    return this.nowFn()
  }

  /** @internal */
  _tryAcquireLock(name: string, ttl: CacheTtl): string | undefined {
    const current = this.locks.get(name)
    if (current !== undefined && current.expiresAt > this.nowFn()) return undefined
    const owner = ulid()
    this.locks.set(name, { owner, expiresAt: ttlToExpiresAt(ttl, this.nowFn()) ?? Infinity })
    return owner
  }

  /** @internal */
  _releaseLock(name: string, owner: string): boolean {
    const current = this.locks.get(name)
    if (current === undefined) return false
    if (current.owner !== owner) return false
    this.locks.delete(name)
    return true
  }

  /** @internal */
  _putWithTags(key: string, value: unknown, ttl: CacheTtl, tags: readonly string[]): void {
    this.entries.set(key, { value, expiresAt: ttlToExpiresAt(ttl, this.nowFn()) })
    this.setKeyTags(key, tags)
  }

  /** @internal */
  _flushTags(tags: readonly string[]): number {
    const toDrop = new Set<string>()
    for (const tag of tags) {
      const keys = this.tagKeys.get(tag)
      if (keys === undefined) continue
      for (const k of keys) toDrop.add(k)
    }
    for (const k of toDrop) {
      this.entries.delete(k)
      this.removeKeyFromAllTags(k)
    }
    return toDrop.size
  }

  private adjust(key: string, delta: number): number {
    const entry = this.entries.get(key)
    if (entry === undefined || this.expired(entry)) {
      this.entries.set(key, { value: delta, expiresAt: null })
      return delta
    }
    const current = typeof entry.value === 'number' ? entry.value : Number(entry.value)
    const next = current + delta
    entry.value = next
    return next
  }

  private setKeyTags(key: string, tags: readonly string[]): void {
    // Reset existing tag wiring for this key first — same key getting
    // re-tagged is a legit operation, and stale tag links would
    // make `flushTags` over-delete.
    this.removeKeyFromAllTags(key)
    const tagSet = new Set(tags)
    this.keyTags.set(key, tagSet)
    for (const tag of tagSet) {
      let bucket = this.tagKeys.get(tag)
      if (bucket === undefined) {
        bucket = new Set()
        this.tagKeys.set(tag, bucket)
      }
      bucket.add(key)
    }
  }

  private removeKeyFromAllTags(key: string): void {
    const tagSet = this.keyTags.get(key)
    if (tagSet === undefined) return
    for (const tag of tagSet) {
      const bucket = this.tagKeys.get(tag)
      if (bucket === undefined) continue
      bucket.delete(key)
      if (bucket.size === 0) this.tagKeys.delete(tag)
    }
    this.keyTags.delete(key)
  }

  private expired(entry: CacheEntry<unknown>): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.nowFn()
  }
}

class MemoryCacheLock implements CacheLock {
  private owner: string | undefined

  constructor(
    private readonly cache: MemoryCache,
    readonly name: string,
    private readonly ttl: CacheTtl,
  ) {}

  async acquire(): Promise<boolean> {
    if (this.owner !== undefined) return false
    const token = this.cache._tryAcquireLock(this.name, this.ttl)
    if (token === undefined) return false
    this.owner = token
    return true
  }

  async release(): Promise<boolean> {
    if (this.owner === undefined) return false
    const released = this.cache._releaseLock(this.name, this.owner)
    this.owner = undefined
    return released
  }

  async block<T>(timeoutMs: number, fn: () => Promise<T> | T): Promise<T> {
    // parseTtl validates the input even though we don't use seconds here.
    if (timeoutMs < 0 || !Number.isFinite(timeoutMs)) {
      throw new Error(
        `CacheLock.block: timeoutMs must be a non-negative finite number; got: ${timeoutMs}`,
      )
    }
    const deadline = this.cache._now() + timeoutMs
    const pollIntervalMs = 50
    while (true) {
      if (await this.acquire()) {
        try {
          return await fn()
        } finally {
          await this.release()
        }
      }
      if (this.cache._now() >= deadline) {
        throw new CacheLockTimeoutError(
          `CacheLock "${this.name}" not acquired within ${timeoutMs}ms.`,
          { context: { lock: this.name, timeoutMs } },
        )
      }
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs))
    }
  }
}

class MemoryTaggedCache implements TaggedCache {
  constructor(
    private readonly cache: MemoryCache,
    readonly tags: readonly string[],
  ) {}

  async put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    this.cache._putWithTags(key, value, ttl, this.tags)
  }

  get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    return this.cache.get<T>(key, fallback)
  }

  forget(key: string): Promise<boolean> {
    return this.cache.forget(key)
  }

  async flush(): Promise<number> {
    return this.cache._flushTags(this.tags)
  }
}
