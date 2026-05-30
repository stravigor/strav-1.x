import { describe, expect, test } from 'bun:test'
import { CacheLockTimeoutError, CacheTtlParseError, MemoryCache } from '../../src/index.ts'

describe('MemoryCache — primitives', () => {
  test('put + get round-trips arbitrary JSON-shaped values', async () => {
    const c = new MemoryCache()
    await c.put('user:1', { id: 1, name: 'Alice' })
    expect(await c.get<{ id: number; name: string }>('user:1')).toEqual({ id: 1, name: 'Alice' })
  })

  test('get returns the fallback when missing', async () => {
    const c = new MemoryCache()
    expect(await c.get('missing')).toBeNull()
    expect(await c.get<string>('missing', 'fb')).toBe('fb')
  })

  test('forget removes and reports whether anything was there', async () => {
    const c = new MemoryCache()
    await c.put('k', 'v')
    expect(await c.forget('k')).toBe(true)
    expect(await c.forget('k')).toBe(false)
  })

  test('has reflects presence + expiry', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    await c.put('k', 'v', '1s')
    expect(await c.has('k')).toBe(true)
    now += 2_000
    expect(await c.has('k')).toBe(false)
  })

  test('TTL expiry evicts on read', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    await c.put('k', 'v', 1) // 1 second
    expect(await c.get<string>('k')).toBe('v')
    now += 2_000
    expect(await c.get('k')).toBeNull()
  })

  test('null TTL means forever', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    await c.put('k', 'v')
    now += 10 * 365 * 24 * 60 * 60 * 1000
    expect(await c.get<string>('k')).toBe('v')
  })

  test('add is put-if-absent', async () => {
    const c = new MemoryCache()
    expect(await c.add('k', 'first', 60)).toBe(true)
    expect(await c.add('k', 'second', 60)).toBe(false)
    expect(await c.get<string>('k')).toBe('first')
  })

  test('add overwrites when previous entry expired', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    await c.add('k', 'first', 1)
    now += 2_000
    expect(await c.add('k', 'second', 60)).toBe(true)
    expect(await c.get<string>('k')).toBe('second')
  })

  test('flush clears entries but not locks', async () => {
    const c = new MemoryCache()
    await c.put('a', 1)
    await c.put('b', 2)
    const lock = c.lock('reindex', 60)
    expect(await lock.acquire()).toBe(true)
    await c.flush()
    expect(await c.get('a')).toBeNull()
    expect(await c.get('b')).toBeNull()
    // Lock survives flush — a holder doesn't lose its lease because
    // someone wanted to clear cache entries.
    expect(await lock.release()).toBe(true)
  })
})

describe('MemoryCache — atomic numeric ops', () => {
  test('increment starts from 0 on missing key', async () => {
    const c = new MemoryCache()
    expect(await c.increment('hits')).toBe(1)
    expect(await c.increment('hits', 4)).toBe(5)
  })

  test('decrement starts from 0 on missing key', async () => {
    const c = new MemoryCache()
    expect(await c.decrement('inventory:sku-1', 3)).toBe(-3)
  })

  test('increment preserves prior entry value', async () => {
    const c = new MemoryCache()
    await c.put('counter', 10)
    expect(await c.increment('counter', 5)).toBe(15)
  })

  test('increment ignores expired entry (treats as missing)', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    await c.put('counter', 100, 1)
    now += 2_000
    expect(await c.increment('counter', 5)).toBe(5)
  })
})

describe('MemoryCache — remember', () => {
  test('hit returns cached, never calls fn', async () => {
    const c = new MemoryCache()
    await c.put('k', 'cached')
    let calls = 0
    const v = await c.remember('k', 60, async () => {
      calls++
      return 'fresh'
    })
    expect(v).toBe('cached')
    expect(calls).toBe(0)
  })

  test('miss computes, stores, returns', async () => {
    const c = new MemoryCache()
    let calls = 0
    const v = await c.remember('k', 60, async () => {
      calls++
      return 'fresh'
    })
    expect(v).toBe('fresh')
    expect(calls).toBe(1)
    expect(await c.get<string>('k')).toBe('fresh')
  })

  test('rememberForever stores with no TTL', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    await c.rememberForever('forever', async () => 'persistent')
    now += 10 * 365 * 24 * 60 * 60 * 1000
    expect(await c.get<string>('forever')).toBe('persistent')
  })
})

describe('MemoryCache — locks', () => {
  test('acquire returns true once, then false on contention', async () => {
    const c = new MemoryCache()
    const lock = c.lock('reindex', 60)
    expect(await lock.acquire()).toBe(true)
    const competing = c.lock('reindex', 60)
    expect(await competing.acquire()).toBe(false)
  })

  test('release frees the slot for the next acquirer', async () => {
    const c = new MemoryCache()
    const a = c.lock('reindex', 60)
    await a.acquire()
    expect(await a.release()).toBe(true)
    const b = c.lock('reindex', 60)
    expect(await b.acquire()).toBe(true)
  })

  test('release on a non-held lock returns false', async () => {
    const c = new MemoryCache()
    const lock = c.lock('reindex', 60)
    expect(await lock.release()).toBe(false)
  })

  test('lock expires automatically after TTL', async () => {
    let now = 1_000_000
    const c = new MemoryCache({ now: () => now })
    const a = c.lock('reindex', 1) // 1 second
    expect(await a.acquire()).toBe(true)
    now += 2_000
    const b = c.lock('reindex', 60)
    expect(await b.acquire()).toBe(true)
  })

  test('block runs fn under the lock and releases', async () => {
    const c = new MemoryCache()
    const result = await c.lock('reindex', 60).block(100, async () => 42)
    expect(result).toBe(42)
    // Lock is released after fn — a fresh acquire works.
    expect(await c.lock('reindex', 60).acquire()).toBe(true)
  })

  test('block throws CacheLockTimeoutError when window exhausts', async () => {
    const c = new MemoryCache()
    const held = c.lock('reindex', 60)
    await held.acquire()
    await expect(c.lock('reindex', 60).block(75, async () => 'never')).rejects.toBeInstanceOf(
      CacheLockTimeoutError,
    )
  })

  test('cross-instance lock — different lock handles compete for the same name', async () => {
    const c = new MemoryCache()
    const a = c.lock('reindex', 60)
    const b = c.lock('reindex', 60)
    expect(await a.acquire()).toBe(true)
    expect(await b.acquire()).toBe(false)
    await a.release()
    expect(await b.acquire()).toBe(true)
  })
})

describe('MemoryCache — tagged', () => {
  test('flush drops every key carrying any of the tags', async () => {
    const c = new MemoryCache()
    await c.tags('user:1', 'leads').put('combined-report', { score: 1 })
    await c.tags('user:1').put('profile', { id: 1 })
    await c.tags('orders').put('basket', { items: 3 })

    const dropped = await c.tags('user:1').flush()
    expect(dropped).toBe(2)
    expect(await c.get('combined-report')).toBeNull()
    expect(await c.get('profile')).toBeNull()
    expect(await c.get<{ items: number }>('basket')).toEqual({ items: 3 })
  })

  test('keys without tags are untouched by tagged flushes', async () => {
    const c = new MemoryCache()
    await c.put('untagged', 'safe')
    await c.tags('users').put('tagged', 'gone')
    await c.tags('users').flush()
    expect(await c.get<string>('untagged')).toBe('safe')
    expect(await c.get('tagged')).toBeNull()
  })

  test('re-tagging a key swaps the tag set', async () => {
    const c = new MemoryCache()
    await c.tags('v1').put('config', { x: 1 })
    await c.tags('v2').put('config', { x: 2 })
    await c.tags('v1').flush()
    // Re-tagged with 'v2' — the v1 flush should not touch it.
    expect(await c.get<{ x: number }>('config')).toEqual({ x: 2 })
  })

  test('forget cleans up tag wiring', async () => {
    const c = new MemoryCache()
    await c.tags('users').put('k', 'v')
    await c.forget('k')
    const dropped = await c.tags('users').flush()
    expect(dropped).toBe(0)
  })

  test('flush returns 0 on unknown tag', async () => {
    const c = new MemoryCache()
    expect(await c.tags('nothing-tagged-with-this').flush()).toBe(0)
  })
})

describe('TTL parser (parseTtl)', () => {
  test('throws on bogus input', async () => {
    const c = new MemoryCache()
    await expect(c.put('k', 'v', '5min')).rejects.toBeInstanceOf(CacheTtlParseError)
    await expect(c.put('k', 'v', '-5')).rejects.toBeInstanceOf(CacheTtlParseError)
    await expect(c.put('k', 'v', Number.NaN)).rejects.toBeInstanceOf(CacheTtlParseError)
  })
})
