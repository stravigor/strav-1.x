/**
 * Integration tests for `RedisCache` against real Redis.
 *
 * Self-skips when `REDIS_URL` is unset or unreachable.
 *
 * Keys are prefixed with `'cachetest:'` so the suite is safe alongside
 * other apps sharing the same DB. The suite truncates everything
 * under that prefix in `beforeAll`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isRedisAvailable } from '@strav/testing'
import { RedisCache } from '../../src/drivers/redis/index.ts'
import { CacheLockTimeoutError } from '../../src/index.ts'

const PREFIX = 'cachetest:'
const AVAILABLE = await isRedisAvailable()

describe.skipIf(!AVAILABLE)('RedisCache — real Redis', () => {
  let cache: RedisCache

  beforeAll(async () => {
    cache = new RedisCache({ url: process.env['REDIS_URL']!, prefix: PREFIX })
    await cache.flush()
  })

  afterAll(async () => {
    await cache.flush()
    await cache.close()
  })

  // ─── Primitives ──────────────────────────────────────────────────────────

  test('put + get round-trips arbitrary JSON-shaped values', async () => {
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

  test('flush drops every prefixed key (and only those)', async () => {
    await cache.put('flush:a', 1)
    await cache.put('flush:b', 2)
    await cache.flush()
    expect(await cache.get('flush:a')).toBeNull()
    expect(await cache.get('flush:b')).toBeNull()
  })

  // ─── Atomic numeric ops ──────────────────────────────────────────────────

  test('increment starts from 0 on missing key', async () => {
    await cache.forget('inc:fresh')
    expect(await cache.increment('inc:fresh')).toBe(1)
    expect(await cache.increment('inc:fresh', 4)).toBe(5)
  })

  test('decrement starts from 0 on missing key', async () => {
    await cache.forget('dec:fresh')
    expect(await cache.decrement('dec:fresh', 3)).toBe(-3)
  })

  test('concurrent increments serialize correctly', async () => {
    await cache.forget('inc:concurrent')
    const N = 25
    await Promise.all(Array.from({ length: N }, () => cache.increment('inc:concurrent')))
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
    const a = cache.lock('lock:basic', 60)
    expect(await a.acquire()).toBe(true)
    const b = cache.lock('lock:basic', 60)
    expect(await b.acquire()).toBe(false)
    await a.release()
  })

  test('release frees the slot via Lua compare-and-delete', async () => {
    const a = cache.lock('lock:release', 60)
    await a.acquire()
    expect(await a.release()).toBe(true)
    const b = cache.lock('lock:release', 60)
    expect(await b.acquire()).toBe(true)
    await b.release()
  })

  test('release scoped on owner — different instance cannot release', async () => {
    const a = cache.lock('lock:owner', 60)
    await a.acquire()
    const b = cache.lock('lock:owner', 60)
    expect(await b.release()).toBe(false) // b never held it
    expect(await a.release()).toBe(true)
  })

  test('expired lock auto-releases', async () => {
    const a = cache.lock('lock:ttl', 1)
    await a.acquire()
    await new Promise((r) => setTimeout(r, 1100))
    const b = cache.lock('lock:ttl', 60)
    expect(await b.acquire()).toBe(true)
    await b.release()
  })

  test('block runs fn under the lock and releases', async () => {
    const v = await cache.lock('lock:block', 60).block(500, async () => 42)
    expect(v).toBe(42)
  })

  test('block throws CacheLockTimeoutError on contention', async () => {
    const held = cache.lock('lock:timeout', 60)
    await held.acquire()
    await expect(
      cache.lock('lock:timeout', 60).block(200, async () => 'never'),
    ).rejects.toBeInstanceOf(CacheLockTimeoutError)
    await held.release()
  })

  // ─── Tagged cache ────────────────────────────────────────────────────────

  test('tagged flush drops keys carrying any of the tags', async () => {
    await cache.tags('user:t1', 'leads').put('tag:report', { score: 1 })
    await cache.tags('user:t1').put('tag:profile', { id: 1 })
    await cache.tags('orders').put('tag:basket', { items: 3 })

    const dropped = await cache.tags('user:t1').flush()
    expect(dropped).toBe(2)
    expect(await cache.get('tag:report')).toBeNull()
    expect(await cache.get('tag:profile')).toBeNull()
    expect(await cache.get<{ items: number }>('tag:basket')).toEqual({ items: 3 })
  })

  test('keys without tags are untouched by tagged flush', async () => {
    await cache.put('tag:untagged', 'safe')
    await cache.tags('users').put('tag:dropme', 'gone')
    await cache.tags('users').flush()
    expect(await cache.get<string>('tag:untagged')).toBe('safe')
    expect(await cache.get('tag:dropme')).toBeNull()
  })

  test('re-tagging a key swaps the tag set', async () => {
    await cache.tags('rt:v1').put('rt:config', { x: 1 })
    await cache.tags('rt:v2').put('rt:config', { x: 2 })
    await cache.tags('rt:v1').flush()
    expect(await cache.get<{ x: number }>('rt:config')).toEqual({ x: 2 })
  })
})
