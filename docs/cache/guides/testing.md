# Testing cache

Three test shapes cover ~95% of what apps need:

| Shape | When | Setup |
|---|---|---|
| **`MemoryCache` with a deterministic clock** | Unit + integration tests for code that calls `Cache` methods | Pass `now: () => fixedTimestamp` to the constructor |
| **`PostgresCache` / `RedisCache` / `MemcachedCache` against real services** | Driver-specific behaviour (locks, tags, atomic ops at scale) | `docker-compose up -d` + `is*Available()` self-skip |
| **`StubCache` / fetch counters** | "Did the service call the cache the right number of times?" | Hand-rolled `Cache` subclass that records every call |

For pure logic tests, no setup — inject `null` or skip the cache dep entirely.

## `MemoryCache` with deterministic clock

The cheapest test shape. Drop a `now: () => number` override into the constructor and you can fast-forward through TTLs without `setTimeout`:

```ts
import { describe, expect, test } from 'bun:test'
import { MemoryCache } from '@strav/cache'

test('expires after TTL', async () => {
  let now = 1_000_000
  const cache = new MemoryCache({ now: () => now })

  await cache.put('k', 'v', '60s')
  expect(await cache.get<string>('k')).toBe('v')

  now += 30 * 1000   // 30 seconds later
  expect(await cache.get<string>('k')).toBe('v')

  now += 35 * 1000   // 65s total → expired
  expect(await cache.get('k')).toBeNull()
})
```

Three reasons to control the clock:

- **Speed.** No real `setTimeout` waits. The test runs in microseconds instead of "wait for TTL".
- **Determinism.** No flake from clock jitter or CI slow nodes; the assertion is exact.
- **Coverage.** You can hit edge cases (entry exactly at expiry, entry expired moments before read) without hoping the scheduler cooperates.

For tests that exercise behaviour across multiple TTLs, define `now` as a `let` at module scope so every test in the file shares the clock:

```ts
let now = 1_000_000
const advance = (seconds: number) => { now += seconds * 1000 }

const cache = new MemoryCache({ now: () => now })

beforeEach(() => {
  now = 1_000_000   // reset between tests
  return cache.flush()
})
```

## Asserting on cache hits and misses

The standard pattern: count how many times the closure ran. A cache hit means it didn't run.

```ts
test('remember caches the result', async () => {
  const cache = new MemoryCache()
  let calls = 0
  const factory = async () => {
    calls++
    return 'computed'
  }

  await cache.remember('k', '5m', factory)
  await cache.remember('k', '5m', factory)
  await cache.remember('k', '5m', factory)

  expect(calls).toBe(1)    // exactly one call → two hits
})
```

For service-level tests, the same shape applies — track how many times the underlying repository / API client was hit:

```ts
test('LeadsService.trending uses the cache', async () => {
  let queries = 0
  const repo = {
    queryTopByScore: async () => {
      queries++
      return [/* seed data */]
    },
  } as unknown as LeadsRepository
  const service = new LeadsService(repo, cache)

  await service.trending()
  await service.trending()

  expect(queries).toBe(1)
})
```

Don't assert on Cache internals (no `cache.size()` checks in production tests). Assert on the observable effect — fewer DB queries, fewer external API calls, deterministic results between calls.

## Lock + atomic-op tests

Locks have race semantics; the simplest way to assert them is to drive them serially in the test:

```ts
test('lock returns true once, false on contention', async () => {
  const cache = new MemoryCache()
  const a = cache.lock('reindex', 60)
  const b = cache.lock('reindex', 60)

  expect(await a.acquire()).toBe(true)
  expect(await b.acquire()).toBe(false)
  expect(await a.release()).toBe(true)
  expect(await b.acquire()).toBe(true)
  await b.release()
})
```

For concurrent assertions, run N requests via `Promise.all`:

```ts
test('concurrent increments serialize', async () => {
  const cache = new MemoryCache()
  await Promise.all(Array.from({ length: 25 }, () => cache.increment('counter')))
  expect(await cache.get<number>('counter')).toBe(25)
})
```

MemoryCache is single-threaded so this is a sanity check rather than a true concurrency test. To catch genuine race conditions, use the Postgres or Redis driver with the actual services running (see below).

## Real-driver integration tests

For driver-specific behaviour (lock owner-token semantics, tagged invalidation cascade, real concurrency), point at the real service:

```ts
import { isRedisAvailable } from '@strav/testing'
import { RedisCache } from '@strav/cache/redis'

const AVAILABLE = await isRedisAvailable()

describe.skipIf(!AVAILABLE)('RedisCache integration', () => {
  let cache: RedisCache

  beforeAll(() => {
    cache = new RedisCache({
      url: process.env.REDIS_URL ?? '',
      prefix: `test-${Date.now()}:`,    // per-run prefix so parallel runs don't collide
    })
  })

  afterAll(async () => {
    await cache.flush()
    await cache.close()
  })

  test('concurrent increments are atomic at the Redis layer', async () => {
    await Promise.all(Array.from({ length: 100 }, () => cache.increment('counter')))
    expect(await cache.get<number>('counter')).toBe(100)
  })

  test('lock release scopes on owner token', async () => {
    const a = cache.lock('test', 60)
    await a.acquire()
    const b = cache.lock('test', 60)
    expect(await b.release()).toBe(false)   // b never held it
    expect(await a.release()).toBe(true)
  })
})
```

Same pattern works for `PostgresCache` (`isPostgresAvailable`) and `MemcachedCache` (`isMemcachedAvailable`). The package's own integration suites under `packages/cache/tests/drivers/*` are the canonical reference for the shape.

Three patterns worth keeping:

- **Per-run prefix.** Multiple suites running against the same Redis / Postgres / Memcached instance would clobber each other. `test-${Date.now()}:` (or `crypto.randomUUID()`) keeps them apart.
- **`describe.skipIf(!AVAILABLE)`.** Tests self-skip when the service isn't running. Run-locally-without-docker stays painless.
- **Cleanup in `afterAll`.** `cache.flush()` (driver-scoped) drops the test data; `cache.close()` returns the pool. Don't try per-test cleanup — slows the suite, leaves no diagnostic trace on failure.

## Stubbing `Cache` for unit tests

For tests where the cache backend doesn't matter — you want to assert "did the controller call `cache.put` with X args?" — roll your own:

```ts
import { Cache, type CacheTtl, type CacheLock, type TaggedCache } from '@strav/cache'

class StubCache extends Cache {
  readonly puts: { key: string; value: unknown; ttl?: CacheTtl }[] = []
  readonly gets: string[] = []
  readonly objects = new Map<string, unknown>()

  override async get<T = unknown>(key: string, fallback: T | null = null): Promise<T | null> {
    this.gets.push(key)
    return (this.objects.get(key) as T) ?? fallback
  }

  override async put(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    this.puts.push({ key, value, ttl })
    this.objects.set(key, value)
  }

  override async forget(key: string): Promise<boolean> {
    return this.objects.delete(key)
  }

  // Only override the methods your tests exercise.
}
```

Wire it as the `Cache` binding in your test container:

```ts
const stub = new StubCache()
const { app } = await bootTestApp({
  providers: [
    {
      name: 'cache',
      register(app) {
        app.singleton(Cache, () => stub)
      },
      async boot() {},
    },
  ],
})

await app.resolve(LeadsService).trending()

expect(stub.puts).toHaveLength(1)
expect(stub.puts[0]?.key).toBe('leads.trending')
expect(stub.puts[0]?.ttl).toBe('5m')
```

When the stub grows past ~50 LOC, switch to `MemoryCache`. The stub is for arg-shape assertions; for behaviour assertions, use the real driver.

## Testing invalidation

Three things to assert:

```ts
test('updating a user invalidates the cached profile', async () => {
  const cache = new MemoryCache()
  await cache.put('user:42', { name: 'Alice' }, '15m')

  const service = new UsersService(repo, cache, events)
  await service.update({ id: 42, name: 'Allison' })

  expect(await cache.get('user:42')).toBeNull()
})

test('updating a user flushes the user:42 tag', async () => {
  const cache = new MemoryCache()
  await cache.tags('user:42').put('profile:42', { name: 'Alice' }, '15m')
  await cache.tags('user:42').put('dashboard:42', { data: 'x' }, '15m')

  const service = new UsersService(repo, cache, events)
  await service.update({ id: 42, name: 'Allison' })

  expect(await cache.get('profile:42')).toBeNull()
  expect(await cache.get('dashboard:42')).toBeNull()
})

test('TTL fires as a safety net when the event-based invalidation breaks', async () => {
  let now = 1_000_000
  const cache = new MemoryCache({ now: () => now })
  await cache.put('user:42', { name: 'Alice' }, '15m')

  // Event listener never fires (simulated bug).
  now += 16 * 60 * 1000   // 16 minutes later
  expect(await cache.get('user:42')).toBeNull()
})
```

The third test is the safety-net assertion — even if event-based invalidation breaks, the TTL eventually evicts. Worth keeping; catches bugs where developers crank TTL to "forever" and assume the events will save them.

## Testing the response cache

If you're building a response-cache layer (cache the full HTTP response keyed by URL):

```ts
test('cached endpoint serves the cached body on the second request', async () => {
  const { app } = await bootTestApp()
  let upstream = 0
  app.singleton(WeatherClient, () => ({
    forecast: async () => {
      upstream++
      return { temp: 22 }
    },
  }))

  const r1 = await app.fetch(new Request('http://x/weather'))
  const r2 = await app.fetch(new Request('http://x/weather'))

  expect(r1.status).toBe(200)
  expect(r2.status).toBe(200)
  expect(upstream).toBe(1)              // second request served from cache
})
```

Same shape applies regardless of which level the cache sits at (HTTP middleware, controller-level `remember`, repository layer). The assertion is always "the underlying call ran N times" — N is determined by the cache's hit/miss pattern.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Tests pass locally, fail in CI | CI doesn't run Redis / Postgres / Memcached | Use `describe.skipIf(!await isXAvailable())` so tests self-skip cleanly |
| Cross-test contamination | Shared `cache` instance, no cleanup | `await cache.flush()` (driver-scoped) in `beforeEach`, or per-test fresh instance |
| Flaky TTL assertions | `setTimeout`-based waits race the test runner | Inject a controllable clock (`now: () => fixedTimestamp`) and advance it manually |
| Stub returns wrong type | `cache.get<User>(...)` defaults to `unknown` | Stub the generic — `override get<T>(key: string): Promise<T \| null>` |
| Production `Cache` resolves in tests | Boot order: production provider registers first | Test-mode provider re-registers `Cache` AFTER the production one; last-write wins in the container |
| Lock tests deadlock | `block()` waiting on a lock the test never releases | Always release in `finally`; use short `timeoutMs` for negative tests |

## Coverage targets

For each cache use case in your app, three tests cover the essentials:

1. **Hit path** — `cache.get` returns the cached value, closure does not run.
2. **Miss path** — `cache.get` returns null, closure runs once, result is cached.
3. **Invalidation** — the documented invalidation event fires, the entry goes away.

For atomic ops:
- **Hit + atomic** — `increment` returns the expected sequence under concurrency.

For locks:
- **Acquire under contention** — first call wins, second returns false.
- **Release under contention** — only the holder can release.

That's 6-10 tests per use case for the framework's coverage; you usually need ~3 per *your* use case for the assertions that matter.

For the framework's own coverage of every driver across every method, see `packages/cache/tests/drivers/*_cache.test.ts` — 70+ tests across the four drivers, exercising every method with both happy paths and failure modes.
