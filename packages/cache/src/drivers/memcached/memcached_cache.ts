/**
 * `MemcachedCache` — Memcached-backed cross-process cache.
 *
 * Operation mapping (text protocol):
 *
 *   - `get` → `get key\r\n` → `VALUE key 0 N\r\n<value>\r\nEND\r\n`.
 *     JSON.parse, fall back to the raw string for non-JSON payloads
 *     (counters return bare decimal text).
 *   - `put` → `set key 0 N bytes\r\n<value>\r\n`.
 *   - `has` → `get` + non-null check.
 *   - `forget` → `delete key\r\n`.
 *   - `flush` → `flush_all\r\n` — wipes the WHOLE server. There's no
 *     prefix-scoped equivalent in Memcached. Apps that share their
 *     Memcached instance with other code shouldn't use `flush`.
 *   - `add` → `add key 0 N bytes\r\n<value>\r\n` (atomic put-if-absent).
 *   - `increment` / `decrement` → `incr key by\r\n` (or `decr`).
 *     Memcached returns `NOT_FOUND` for missing keys; the driver
 *     falls back to an `add` of the delta, then re-`incr`s on race.
 *   - `lock(name, ttl)` → `add` (atomic). **No CAS-scoped release** —
 *     a slow caller's expired lock can be released by a different
 *     holder. Apps that need strict ownership use Redis or Postgres.
 *   - `tags(...)` → throws `CacheDriverError`. Memcached has no
 *     native sets and no SCAN; emulating tags would require a
 *     full-server scan per flush. Out of scope.
 *
 * Keys are namespaced with `prefix` (default `'strav:'`). Memcached
 * keys are ASCII-only, no whitespace, ≤250 bytes — the driver does
 * NOT validate this; callers are expected to keep keys clean.
 */

import { Cache } from '../../cache.ts'
import { CacheConfigError, CacheDriverError, CacheLockTimeoutError } from '../../cache_error.ts'
import { parseTtl } from '../../ttl.ts'
import type { CacheLock, CacheTtl, TaggedCache } from '../../types.ts'
import { MemcachedClient, type MemcachedClientOptions } from './memcached_client.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export interface MemcachedCacheOptions extends Omit<MemcachedClientOptions, 'host' | 'port'> {
  host: string
  port: number
  /** Key namespace prefix. Default `'strav:'`. */
  prefix?: string
  /** Pre-constructed client for tests. */
  client?: MemcachedClient
}

export class MemcachedCache extends Cache {
  private readonly client: MemcachedClient
  private readonly ownsClient: boolean
  private readonly prefix: string

  constructor(options: MemcachedCacheOptions) {
    super()
    this.prefix = options.prefix ?? 'strav:'
    if (options.client !== undefined) {
      this.client = options.client
      this.ownsClient = false
    } else {
      if (!options.host || !options.port) {
        throw new CacheConfigError(
          'MemcachedCache requires `host` + `port` (or an injected `client`).',
        )
      }
      this.client = new MemcachedClient({
        host: options.host,
        port: options.port,
        ...(options.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: options.connectTimeoutMs }
          : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
      })
      this.ownsClient = true
    }
  }

  // ─── Core primitives ───────────────────────────────────────────────────────

  override async get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    const reply = DECODER.decode(await this.client.send(`get ${this.k(key)}\r\n`))
    if (reply === 'END\r\n') return fallback
    if (!reply.startsWith('VALUE ')) {
      throw new CacheDriverError(`MemcachedCache.get: unexpected reply: ${trimError(reply)}`, {
        context: { key },
      })
    }
    const headerEnd = reply.indexOf('\r\n')
    const header = reply.slice(0, headerEnd) // `VALUE key 0 N`
    const bytes = Number(header.split(' ')[3] ?? '0')
    const valueStart = headerEnd + 2
    const value = reply.slice(valueStart, valueStart + bytes)
    return this.decode<T>(value, fallback)
  }

  override async put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    const seconds = parseTtl(ttl) ?? 0
    await this.storeCommand('set', key, value, seconds)
  }

  override async has(key: string): Promise<boolean> {
    const reply = DECODER.decode(await this.client.send(`get ${this.k(key)}\r\n`))
    return !reply.startsWith('END\r\n')
  }

  override async forget(key: string): Promise<boolean> {
    const reply = DECODER.decode(await this.client.send(`delete ${this.k(key)}\r\n`))
    return reply.startsWith('DELETED')
  }

  override async flush(): Promise<void> {
    // flush_all is server-wide — apps sharing the instance shouldn't
    // call this. There is no scoped equivalent in Memcached.
    await this.client.send('flush_all\r\n')
  }

  override async add(key: string, value: unknown, ttl: CacheTtl): Promise<boolean> {
    const seconds = parseTtl(ttl) ?? 0
    return this.storeCommand('add', key, value, seconds)
  }

  override async increment(key: string, by = 1): Promise<number> {
    return this.adjust(key, by, 'incr')
  }

  override async decrement(key: string, by = 1): Promise<number> {
    return this.adjust(key, by, 'decr')
  }

  override lock(name: string, ttl: CacheTtl): CacheLock {
    return new MemcachedCacheLock(this, name, ttl)
  }

  override tags(..._tags: string[]): TaggedCache {
    throw new CacheDriverError(
      'MemcachedCache does not support tagged invalidation — Memcached has no native sets and no SCAN. Use RedisCache or PostgresCache for tag support.',
    )
  }

  override async close(): Promise<void> {
    if (!this.ownsClient) return
    await this.client.close()
  }

  // ─── Lock internals ────────────────────────────────────────────────────────

  /** @internal */
  async _tryAcquireLock(name: string, ttl: CacheTtl): Promise<string | undefined> {
    const seconds = parseTtl(ttl)
    if (seconds === null) {
      throw new CacheConfigError('MemcachedCache.lock: TTL must be set — no "forever" locks.')
    }
    const owner = randomToken()
    const stored = await this.storeCommand('add', `lock:${name}`, owner, seconds)
    return stored ? owner : undefined
  }

  /** @internal */
  async _releaseLock(name: string, owner: string): Promise<boolean> {
    // No CAS-scoped delete in Memcached's text protocol — read the
    // value, compare, then delete. A slim race window exists where
    // another holder acquired between our `get` and `delete`; document
    // the limitation and let apps that need strict ownership pick a
    // different driver.
    const current = await this.get<string>(`lock:${name}`)
    if (current !== owner) return false
    return this.forget(`lock:${name}`)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async storeCommand(
    cmd: 'set' | 'add',
    key: string,
    value: unknown,
    seconds: number,
  ): Promise<boolean> {
    const encoded = ENCODER.encode(JSON.stringify(value))
    const header = `${cmd} ${this.k(key)} 0 ${seconds} ${encoded.length}\r\n`
    const headerBytes = ENCODER.encode(header)
    const trailer = ENCODER.encode('\r\n')
    const payload = new Uint8Array(headerBytes.length + encoded.length + trailer.length)
    payload.set(headerBytes, 0)
    payload.set(encoded, headerBytes.length)
    payload.set(trailer, headerBytes.length + encoded.length)
    const reply = DECODER.decode(await this.client.send(payload))
    if (reply.startsWith('STORED')) return true
    if (reply.startsWith('NOT_STORED')) return false
    throw new CacheDriverError(`MemcachedCache.${cmd}: unexpected reply: ${trimError(reply)}`, {
      context: { key },
    })
  }

  private async adjust(key: string, by: number, op: 'incr' | 'decr'): Promise<number> {
    const reply = DECODER.decode(await this.client.send(`${op} ${this.k(key)} ${by}\r\n`))
    if (/^\d+/.test(reply)) return Number(reply.split('\r\n')[0])
    if (!reply.startsWith('NOT_FOUND')) {
      throw new CacheDriverError(`MemcachedCache.${op}: unexpected reply: ${trimError(reply)}`, {
        context: { key },
      })
    }
    // NOT_FOUND — try to seed via add(delta). Use no expiry (0) so the
    // counter behaves like Redis (forever until forget).
    const seedValue = op === 'incr' ? by : -by
    const stored = await this.storeCommand('add', key, seedValue, 0)
    if (stored) return seedValue
    // Race — another caller created the key first. Re-run incr/decr.
    const replyAfter = DECODER.decode(await this.client.send(`${op} ${this.k(key)} ${by}\r\n`))
    if (/^\d+/.test(replyAfter)) return Number(replyAfter.split('\r\n')[0])
    throw new CacheDriverError(
      `MemcachedCache.${op}: still NOT_FOUND after seed retry — odd race or non-numeric value at "${key}".`,
      { context: { key } },
    )
  }

  private k(key: string): string {
    return `${this.prefix}${key}`
  }

  private decode<T>(raw: string, fallback: T | null): T | null {
    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as unknown as T
    }
  }
}

class MemcachedCacheLock implements CacheLock {
  private owner: string | undefined

  constructor(
    private readonly cache: MemcachedCache,
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
    const pollIntervalMs = 75
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

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function trimError(reply: string): string {
  return reply.replace(/\r\n$/, '').slice(0, 200)
}
