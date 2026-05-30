/**
 * Integration tests for `PostgresCache` against real Postgres.
 *
 * Self-skips when no Postgres is available — matches the integration
 * suites' contract (`isPostgresAvailable()`).
 *
 * Each test owns its keys (prefixed with a per-test slug) so the suite
 * is safe to run in parallel against the same DB instance.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTestDatabase, isPostgresAvailable, resetSchema } from '@strav/testing'
import { applyCacheMigration, PostgresCache } from '../../src/drivers/postgres/index.ts'
import { CacheLockTimeoutError } from '../../src/index.ts'

const PG_AVAILABLE = await isPostgresAvailable()

describe.skipIf(!PG_AVAILABLE)('PostgresCache — real Postgres', () => {
  let db: ReturnType<typeof createTestDatabase>
  let cache: PostgresCache

  beforeAll(async () => {
    db = createTestDatabase()
    await resetSchema(db)
    await applyCacheMigration(db)
    cache = new PostgresCache({ db, cleanupIntervalMs: 0 })
  })

  afterAll(async () => {
    await cache.close()
    await db.close({ timeout: 2 })
  })

  // ─── Primitives ──────────────────────────────────────────────────────────

  test('migration creates the three cache tables + indexes', async () => {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'strav_cache%'
       ORDER BY table_name`,
    )
    expect(tables.map((t) => t.table_name)).toEqual([
      'strav_cache',
      'strav_cache_locks',
      'strav_cache_tags',
    ])
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename LIKE 'strav_cache%'`,
    )
    const names = indexes.map((i) => i.indexname)
    expect(names).toContain('idx_strav_cache_expires_at')
    expect(names).toContain('idx_strav_cache_tags_tag')
  })

  test('put + get round-trips JSON-shaped values', async () => {
    await cache.put('rt:user:1', { id: 1, name: 'Alice' })
    expect(await cache.get<{ id: number; name: string }>('rt:user:1')).toEqual({
      id: 1,
      name: 'Alice',
    })
  })

  test('get returns the fallback when missing', async () => {
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
    expect(await cache.add('add:k', 'first', 60)).toBe(true)
    expect(await cache.add('add:k', 'second', 60)).toBe(false)
    expect(await cache.get<string>('add:k')).toBe('first')
  })

  test('add overwrites an expired entry', async () => {
    await cache.add('add:exp', 'first', 1)
    await new Promise((r) => setTimeout(r, 1100))
    expect(await cache.add('add:exp', 'second', 60)).toBe(true)
    expect(await cache.get<string>('add:exp')).toBe('second')
  })

  // ─── Atomic numeric ops ──────────────────────────────────────────────────

  test('increment starts from 0 on missing key', async () => {
    expect(await cache.increment('inc:fresh')).toBe(1)
    expect(await cache.increment('inc:fresh', 4)).toBe(5)
  })

  test('decrement starts from 0 on missing key', async () => {
    expect(await cache.decrement('dec:fresh', 3)).toBe(-3)
  })

  test('increment preserves prior entry value', async () => {
    await cache.put('inc:carry', 10)
    expect(await cache.increment('inc:carry', 5)).toBe(15)
  })

  test('increment resets when entry expired', async () => {
    await cache.put('inc:expired', 100, 1)
    await new Promise((r) => setTimeout(r, 1100))
    expect(await cache.increment('inc:expired', 5)).toBe(5)
  })

  test('concurrent increments serialize correctly', async () => {
    await cache.put('inc:concurrent', 0)
    const N = 20
    await Promise.all(Array.from({ length: N }, () => cache.increment('inc:concurrent')))
    expect(await cache.get<number>('inc:concurrent')).toBe(N)
  })

  // ─── remember / rememberForever ──────────────────────────────────────────

  test('remember hits cache on second call', async () => {
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

  test('release frees the slot', async () => {
    const a = cache.lock('lock:release', 60)
    await a.acquire()
    expect(await a.release()).toBe(true)
    const b = cache.lock('lock:release', 60)
    expect(await b.acquire()).toBe(true)
    await b.release()
  })

  test('release on non-held lock returns false', async () => {
    const lock = cache.lock('lock:nohold', 60)
    expect(await lock.release()).toBe(false)
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
    // Next acquire works — released after fn.
    expect(await cache.lock('lock:block', 60).acquire()).toBe(true)
    await cache.lock('lock:block', 60).release()
  })

  test('block throws CacheLockTimeoutError on contention', async () => {
    const held = cache.lock('lock:timeout', 60)
    await held.acquire()
    await expect(
      cache.lock('lock:timeout', 60).block(300, async () => 'never'),
    ).rejects.toBeInstanceOf(CacheLockTimeoutError)
    await held.release()
  })

  test('release scoped on owner — different lock instance cannot release', async () => {
    const a = cache.lock('lock:owner', 60)
    await a.acquire()
    // Manually craft a lock instance that thinks it owns the slot —
    // simulated by using a second instance which has its own owner
    // token. release() on it should return false because Postgres
    // releases scope on (name, owner).
    const b = cache.lock('lock:owner', 60)
    expect(await b.release()).toBe(false)
    expect(await a.release()).toBe(true)
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

  test('keys without tags untouched by tagged flush', async () => {
    await cache.put('tag:untouched', 'safe')
    await cache.tags('users').put('tag:dropme', 'gone')
    await cache.tags('users').flush()
    expect(await cache.get<string>('tag:untouched')).toBe('safe')
    expect(await cache.get('tag:dropme')).toBeNull()
  })

  test('re-tagging a key swaps the tag set', async () => {
    await cache.tags('rt:v1').put('rt:config', { x: 1 })
    await cache.tags('rt:v2').put('rt:config', { x: 2 })
    await cache.tags('rt:v1').flush()
    expect(await cache.get<{ x: number }>('rt:config')).toEqual({ x: 2 })
  })

  test('FK cascade drops tag rows when entry is forgotten', async () => {
    await cache.tags('fk:test').put('fk:k', 'v')
    await cache.forget('fk:k')
    // Tagged flush should find nothing left to drop.
    expect(await cache.tags('fk:test').flush()).toBe(0)
  })

  // ─── Maintenance ─────────────────────────────────────────────────────────

  test('sweepOnce deletes expired entries', async () => {
    await cache.put('sweep:k1', 'a', 1)
    await cache.put('sweep:k2', 'b', 1)
    await cache.put('sweep:k3', 'c', 60)
    await new Promise((r) => setTimeout(r, 1100))
    const deleted = await cache.sweepOnce()
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(await cache.get<string>('sweep:k3')).toBe('c')
  })

  test('sweepLocksOnce deletes expired locks', async () => {
    const lock = cache.lock('sweep:lock', 1)
    await lock.acquire()
    await new Promise((r) => setTimeout(r, 1100))
    const deleted = await cache.sweepLocksOnce()
    expect(deleted).toBeGreaterThanOrEqual(1)
  })
})
