/**
 * Integration tests for `MemcachedCache` against real Memcached.
 *
 * Self-skips when `MEMCACHED_HOST` / `MEMCACHED_PORT` are unset or the
 * server is unreachable.
 *
 * Memcached's `flush_all` is server-wide — the suite calls it in
 * `beforeAll` to start from a clean slate. Don't run alongside other
 * Memcached consumers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isMemcachedAvailable } from '@strav/testing'
import { MemcachedCache } from '../../src/drivers/memcached/index.ts'
import { CacheDriverError, CacheLockTimeoutError } from '../../src/index.ts'

const PREFIX = 'mctest:'
const AVAILABLE = await isMemcachedAvailable()

describe.skipIf(!AVAILABLE)('MemcachedCache — real Memcached', () => {
  let cache: MemcachedCache

  beforeAll(async () => {
    cache = new MemcachedCache({
      host: process.env['MEMCACHED_HOST']!,
      port: Number(process.env['MEMCACHED_PORT']),
      prefix: PREFIX,
    })
    await cache.flush()
  })

  afterAll(async () => {
    await cache.flush()
    await cache.close()
  })

  // ─── Primitives ──────────────────────────────────────────────────────────

  test('put + get round-trips JSON-shaped values', async () => {
    await cache.put('rt:user:1', { id: 1, name: 'Alice' })
    expect(await cache.get<{ id: number; name: string }>('rt:user:1')).toEqual({
      id: 1,
      name: 'Alice',
    })
  })

  test('get returns fallback when missing', async () => {
    expect(await cache.get('miss:absent')).toBeNull()
    expect(await cache.get<string>('miss:absent', 'fb')).toBe('fb')
  })

  test('has reflects presence + TTL expiry', async () => {
    await cache.put('has:k', 'v', '1s')
    expect(await cache.has('has:k')).toBe(true)
    await new Promise((r) => setTimeout(r, 1100))
    expect(await cache.has('has:k')).toBe(false)
  })

  test('forget removes and reports', async () => {
    await cache.put('forget:k', 'v')
    expect(await cache.forget('forget:k')).toBe(true)
    expect(await cache.forget('forget:k')).toBe(false)
  })

  test('add is put-if-absent', async () => {
    await cache.forget('add:k')
    expect(await cache.add('add:k', 'first', 60)).toBe(true)
    expect(await cache.add('add:k', 'second', 60)).toBe(false)
    expect(await cache.get<string>('add:k')).toBe('first')
  })

  // ─── Atomic numeric ops (seed-via-add path) ──────────────────────────────

  test('increment seeds at delta on missing key', async () => {
    await cache.forget('inc:fresh')
    expect(await cache.increment('inc:fresh', 4)).toBe(4)
    expect(await cache.increment('inc:fresh', 1)).toBe(5)
  })

  test('decrement seeds at -delta on missing key', async () => {
    await cache.forget('dec:fresh')
    // Memcached's decr won't go below 0 once a counter exists; the
    // seed path bypasses that since it adds the negative as the
    // initial value.
    expect(await cache.decrement('dec:fresh', 3)).toBe(-3)
  })

  test('concurrent increments serialize correctly', async () => {
    await cache.forget('inc:concurrent')
    const N = 20
    await Promise.all(Array.from({ length: N }, () => cache.increment('inc:concurrent')))
    // Once seeded by one of the concurrent callers, the rest take
    // the incr path.
    expect(await cache.get<number>('inc:concurrent')).toBe(N)
  })

  // ─── Remember ────────────────────────────────────────────────────────────

  test('remember hits cache on second call', async () => {
    await cache.forget('rem:hit')
    let calls = 0
    const v1 = await cache.remember('rem:hit', 60, async () => {
      calls++
      return 'fresh'
    })
    const v2 = await cache.remember('rem:hit', 60, async () => {
      calls++
      return 'fresh-2'
    })
    expect(v1).toBe('fresh')
    expect(v2).toBe('fresh')
    expect(calls).toBe(1)
  })

  // ─── Locks ───────────────────────────────────────────────────────────────

  test('lock acquire returns true once', async () => {
    await cache.forget('lock:basic')
    const a = cache.lock('lock:basic', 60)
    expect(await a.acquire()).toBe(true)
    const b = cache.lock('lock:basic', 60)
    expect(await b.acquire()).toBe(false)
    await a.release()
  })

  test('release frees the slot', async () => {
    await cache.forget('lock:release')
    const a = cache.lock('lock:release', 60)
    await a.acquire()
    expect(await a.release()).toBe(true)
    const b = cache.lock('lock:release', 60)
    expect(await b.acquire()).toBe(true)
    await b.release()
  })

  test('release scoped on owner — different instance cannot release', async () => {
    await cache.forget('lock:owner')
    const a = cache.lock('lock:owner', 60)
    await a.acquire()
    const b = cache.lock('lock:owner', 60)
    expect(await b.release()).toBe(false)
    expect(await a.release()).toBe(true)
  })

  test('expired lock auto-releases', async () => {
    await cache.forget('lock:ttl')
    const a = cache.lock('lock:ttl', 1)
    await a.acquire()
    await new Promise((r) => setTimeout(r, 1100))
    const b = cache.lock('lock:ttl', 60)
    expect(await b.acquire()).toBe(true)
    await b.release()
  })

  test('block runs fn under the lock and releases', async () => {
    await cache.forget('lock:block')
    const v = await cache.lock('lock:block', 60).block(500, async () => 42)
    expect(v).toBe(42)
  })

  test('block throws CacheLockTimeoutError on contention', async () => {
    await cache.forget('lock:timeout')
    const held = cache.lock('lock:timeout', 60)
    await held.acquire()
    await expect(
      cache.lock('lock:timeout', 60).block(250, async () => 'never'),
    ).rejects.toBeInstanceOf(CacheLockTimeoutError)
    await held.release()
  })

  // ─── tags() is unsupported ───────────────────────────────────────────────

  test('tags() throws CacheDriverError', () => {
    expect(() => cache.tags('users')).toThrow(CacheDriverError)
  })
})
