/**
 * `RedisCache` — Redis-backed cross-process cache.
 *
 * Uses Bun's built-in `Bun.RedisClient` (since Bun 1.2) — no
 * third-party Redis client dependency, same pure-fetch ethos as the
 * rest of the framework.
 *
 * Operation mapping:
 *
 *   - `get` → `GET key`, JSON.parse the result. Non-JSON strings
 *     (returned from numeric counters) round-trip as strings.
 *   - `put` → `SET key value EX seconds` (or without EX for no-expiry).
 *   - `has` → `EXISTS key`.
 *   - `forget` → `DEL key`.
 *   - `flush` → `SCAN MATCH prefix:* COUNT n` + `DEL` in batches.
 *     **NOT `FLUSHDB`** — apps may share the Redis DB with other code.
 *   - `add` → `SET key value NX EX seconds` (atomic put-if-absent).
 *   - `increment` / `decrement` → `INCRBY` / `DECRBY` (atomic). Note:
 *     Redis stores counters as strings; existing values from `put`
 *     get re-coerced via the SET-INCRBY path. Expired counters reset
 *     to the delta — Redis's natural behaviour.
 *   - `lock(name, ttl)` → SET NX EX with a per-acquire owner token
 *     and a Lua-eval release that compares-and-deletes.
 *   - `tags(...)` → SADD/SREM/SMEMBERS keyed by `prefix:tag:<tag>`.
 *
 * Keys are namespaced by `prefix` (default `'strav:'`) so the driver
 * coexists with other Redis use. Tag-tracking keys use
 * `<prefix>tag:<tag>` and `<prefix>tagged:<key>` so they don't collide
 * with app keys that happen to start with `tag:`.
 */

import { ulid } from '@strav/kernel'
import { RedisClient } from 'bun'
import { Cache } from '../../cache.ts'
import { CacheConfigError, CacheLockTimeoutError } from '../../cache_error.ts'
import { parseTtl } from '../../ttl.ts'
import type { CacheLock, CacheTtl, TaggedCache } from '../../types.ts'

export interface RedisCacheOptions {
  /** Redis connection URL — `redis://host:port` or `rediss://…` for TLS. */
  url: string
  /**
   * Key namespace prefix. Default `'strav:'`. Set differently per app
   * if multiple apps share the same Redis DB.
   */
  prefix?: string
  /**
   * Custom `RedisClient` for tests. When omitted, the driver
   * constructs one from `url`.
   */
  client?: RedisClient
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`.trim()

export class RedisCache extends Cache {
  private readonly client: RedisClient
  private readonly ownsClient: boolean
  private readonly prefix: string

  constructor(options: RedisCacheOptions) {
    super()
    if (!options.url && options.client === undefined) {
      throw new CacheConfigError('RedisCache requires a `url` (or an injected `client`).')
    }
    this.prefix = options.prefix ?? 'strav:'
    this.ownsClient = options.client === undefined
    this.client = options.client ?? new RedisClient(options.url)
  }

  // ─── Core primitives ───────────────────────────────────────────────────────

  override async get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    const raw = await this.client.get(this.k(key))
    if (raw === null) return fallback
    return this.decode<T>(raw, fallback)
  }

  override async put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    const seconds = parseTtl(ttl)
    if (seconds === null) {
      await this.client.set(this.k(key), JSON.stringify(value))
    } else {
      await this.client.set(this.k(key), JSON.stringify(value), 'EX', seconds)
    }
  }

  override async has(key: string): Promise<boolean> {
    return this.client.exists(this.k(key))
  }

  override async forget(key: string): Promise<boolean> {
    const removed = await this.client.del(this.k(key))
    // Tag wiring lives in two parallel sets — drop the per-key set;
    // its membership in the tag-keyed sets gets reaped lazily at the
    // next flush() (membership of a deleted key is harmless).
    await this.client.del(this.taggedKey(key))
    return removed > 0
  }

  override async flush(): Promise<void> {
    // SCAN + DEL: walk every key under our prefix, in batches.
    // FLUSHDB would wipe other apps sharing the same Redis DB.
    let cursor = '0'
    do {
      const reply = (await this.client.send('SCAN', [
        cursor,
        'MATCH',
        `${this.prefix}*`,
        'COUNT',
        '500',
      ])) as [string, string[]]
      const [nextCursor, keys] = reply
      if (keys.length > 0) {
        await this.client.del(...keys)
      }
      cursor = nextCursor
    } while (cursor !== '0')
  }

  override async add(key: string, value: unknown, ttl: CacheTtl): Promise<boolean> {
    const seconds = parseTtl(ttl)
    let reply: 'OK' | null
    if (seconds === null) {
      reply = await this.client.set(this.k(key), JSON.stringify(value), 'NX')
    } else {
      reply = (await this.client.send('SET', [
        this.k(key),
        JSON.stringify(value),
        'NX',
        'EX',
        String(seconds),
      ])) as 'OK' | null
    }
    return reply === 'OK'
  }

  override async increment(key: string, by = 1): Promise<number> {
    return this.client.incrby(this.k(key), by)
  }

  override async decrement(key: string, by = 1): Promise<number> {
    return this.client.decrby(this.k(key), by)
  }

  override lock(name: string, ttl: CacheTtl): CacheLock {
    return new RedisCacheLock(this, name, ttl)
  }

  override tags(...tags: string[]): TaggedCache {
    return new RedisTaggedCache(this, tags)
  }

  override async close(): Promise<void> {
    if (!this.ownsClient) return
    try {
      this.client.close()
    } catch {
      // Already closed or never connected.
    }
  }

  // ─── Lock + tag internals ──────────────────────────────────────────────────

  /** @internal */
  async _tryAcquireLock(name: string, ttl: CacheTtl): Promise<string | undefined> {
    const seconds = parseTtl(ttl)
    if (seconds === null) {
      throw new CacheConfigError('RedisCache.lock: TTL must be set — no "forever" locks.')
    }
    const owner = ulid()
    const reply = (await this.client.send('SET', [
      this.lockKey(name),
      owner,
      'NX',
      'EX',
      String(seconds),
    ])) as 'OK' | null
    return reply === 'OK' ? owner : undefined
  }

  /** @internal */
  async _releaseLock(name: string, owner: string): Promise<boolean> {
    const reply = (await this.client.send('EVAL', [
      RELEASE_SCRIPT,
      '1',
      this.lockKey(name),
      owner,
    ])) as number
    return reply === 1
  }

  /** @internal */
  async _putWithTags(
    key: string,
    value: unknown,
    ttl: CacheTtl,
    tags: readonly string[],
  ): Promise<void> {
    await this.put(key, value, ttl)
    if (tags.length === 0) {
      await this.client.del(this.taggedKey(key))
      return
    }
    // Two parallel sets: tag → keys (the flush target) and
    // key → tags (so re-tagging swaps cleanly). SADD is variadic but
    // Bun's typed surface tightens to `...members: string[]`.
    const old = await this.client.smembers(this.taggedKey(key))
    if (old.length > 0) {
      for (const tag of old) {
        await this.client.srem(this.tagKey(tag), this.k(key))
      }
      await this.client.del(this.taggedKey(key))
    }
    await this.client.sadd(this.taggedKey(key), ...tags)
    for (const tag of tags) {
      await this.client.sadd(this.tagKey(tag), this.k(key))
    }
  }

  /** @internal */
  async _flushTags(tags: readonly string[]): Promise<number> {
    if (tags.length === 0) return 0
    const allKeys = new Set<string>()
    for (const tag of tags) {
      const members = await this.client.smembers(this.tagKey(tag))
      for (const m of members) allKeys.add(m)
      // Drop the tag's index set itself — every membership we just
      // read is about to be DEL'd, so the set is stale.
      await this.client.del(this.tagKey(tag))
    }
    if (allKeys.size === 0) return 0
    // The keys we got are already prefixed; pass them straight to DEL.
    const list = [...allKeys]
    await this.client.del(...list)
    // Drop the per-key tag-list set too — it points at the same tags
    // we just deleted.
    for (const k of list) {
      // Reverse the prefix to get the bare app key, then build the
      // tagged-key.
      if (k.startsWith(this.prefix)) {
        const bare = k.slice(this.prefix.length)
        await this.client.del(this.taggedKey(bare))
      }
    }
    return list.length
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private k(key: string): string {
    return `${this.prefix}${key}`
  }

  private lockKey(name: string): string {
    return `${this.prefix}lock:${name}`
  }

  private tagKey(tag: string): string {
    return `${this.prefix}tag:${tag}`
  }

  private taggedKey(key: string): string {
    return `${this.prefix}tagged:${key}`
  }

  private decode<T>(raw: string, fallback: T | null): T | null {
    // Counter values (INCRBY/DECRBY) come back as numeric strings;
    // they're not JSON, so JSON.parse will succeed on `"42"` but
    // throws on values like `"OK"`. Try JSON.parse first, fall back
    // to the raw string for non-JSON-looking content.
    try {
      return JSON.parse(raw) as T
    } catch {
      // Either a counter that bypassed JSON encoding or an unexpected
      // non-JSON payload. Returning the raw string is the friendlier
      // default; bad payloads degrade gracefully rather than going
      // null.
      return raw as unknown as T
    }
  }
}

class RedisCacheLock implements CacheLock {
  private owner: string | undefined

  constructor(
    private readonly cache: RedisCache,
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
    const pollIntervalMs = 50
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

class RedisTaggedCache implements TaggedCache {
  constructor(
    private readonly cache: RedisCache,
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
