# @strav/cache

Key/value cache with TTLs. The package exposes the `Cache` abstraction every consumer injects, plus four concrete drivers — `MemoryCache`, `PostgresCache`, `RedisCache`, `MemcachedCache`. Apps swap providers in `bootstrap/providers.ts`; controllers / services stay driver-agnostic.

> **Status: 1.0.0-alpha.** Four drivers shipped. All implement the full Cache surface (`get`/`put`/`forget`/`has`/`flush`/`add`/`increment`/`decrement`/`remember`/`rememberForever`/`lock`/`tags`) except Memcached, which throws on `tags()` because the protocol has no native sets or SCAN. No third-party client deps — Redis uses Bun's built-in `RedisClient`, Memcached uses a minimal text-protocol client over `Bun.connect`.

Lives in its own package rather than `@strav/kernel` so the kernel stays free of the database peer the Postgres driver requires. Same dependency shape as `@strav/broadcast`.

## What's here

| Export | Notes |
|---|---|
| `Cache` | Abstract base + container token. Subclasses MUST override `get`/`put`/`has`/`forget`/`flush`/`add`/`increment`/`decrement`/`lock`/`tags`. Base provides `remember` + `rememberForever` + a default no-op `close` |
| `CacheLock` / `TaggedCache` | Wrapper interfaces returned by `cache.lock(name, ttl)` and `cache.tags(...names)` |
| `CacheTtl` | `string` (`'10m'`/`'1h'`/`'45s'`/`'2d'`) \| `number` (seconds) \| `null` (no expiry) |
| `parseTtl` / `ttlToExpiresAt` | TTL helpers — exported for driver authors |
| `CacheError` + `CacheConfigError` / `CacheDriverError` / `CacheLockTimeoutError` / `CacheTtlParseError` | Typed error hierarchy with stable `code`s |
| `CacheProvider` | Wires `MemoryCache` under the `Cache` token. Default for single-node deployments |
| `MemoryCache` | In-process. Bounded buffer; locks + tags via parallel maps; `subscriberCount`-style diagnostics |
| `PostgresCache` (subpath) | Three-table backplane. Atomic ops via row locks + `INSERT … ON CONFLICT DO UPDATE`. Background sweep for expired rows + expired locks |
| `PostgresCacheProvider` (subpath) | Wires `PostgresCache` under the same `Cache` token |
| `applyCacheMigration` (subpath) | Raw DDL for the three tables + their indexes — schemas aren't registered with `SchemaRegistry` (composite PK on tags, text PK on cache/locks don't fit the schema DSL) |
| `RedisCache` (subpath) | Uses Bun's built-in `RedisClient`. Atomic `INCRBY` / `DECRBY`. Locks via `SET NX EX` + Lua compare-and-delete release. Tags via SADD/SREM/SMEMBERS keyed by prefix. `flush` uses SCAN+DEL (prefix-scoped) — never `FLUSHDB` |
| `RedisCacheProvider` (subpath) | Wires `RedisCache` under the same `Cache` token. Reads `url` + optional `prefix` from `config.cache` |
| `MemcachedCache` (subpath) | Text-protocol client over `Bun.connect`. Atomic `incr`/`decr` (with seed-via-`add` for missing keys), `add` for put-if-absent, locks via `add`. **`tags()` throws** — Memcached has no native sets or SCAN. `flush` runs server-wide `flush_all` |
| `MemcachedCacheProvider` (subpath) | Wires `MemcachedCache` under the same `Cache` token. Reads `host` + `port` from `config.cache` |
| `MemcachedClient` (subpath) | The text-protocol client itself, exposed for apps that need direct Memcached access without the Cache wrapper |

## Install

```bash
bun add @strav/cache
# Postgres backplane only: also need @strav/database
bun add @strav/database
```

## Minimal example — single-node dev

`config/cache.ts` is optional for the memory driver; defaults are sane.

```ts
// bootstrap/providers.ts
import { ConfigProvider, LoggerProvider } from '@strav/kernel'
import { CacheProvider } from '@strav/cache'

export default [
  new ConfigProvider({ /* ... */ }),
  new LoggerProvider(),
  new CacheProvider(),
]
```

```ts
@inject()
class TrendingController {
  constructor(private readonly cache: Cache, private readonly leads: LeadRepository) {}

  async show(): Promise<Response> {
    const top = await this.cache.remember('leads.trending', '5m', async () => {
      return this.leads.query().orderBy('score', 'desc').limit(10).get()
    })
    return Response.json(top)
  }
}
```

## Basic operations

```ts
await cache.put('user:42', user, '10m')
await cache.put('feature.x', true, 3600)        // seconds also work
await cache.put('forever', { config: true })    // no TTL → persists until forget/flush

const u = await cache.get<User>('user:42')      // User | null
const ok = await cache.get<boolean>('feature.x', false)   // default if missing

await cache.has('user:42')                       // boolean
await cache.forget('user:42')                    // returns true if anything removed
await cache.flush()                              // DEV — clears everything
```

Generics ride on the call site (`cache.get<User>(...)`). The wire layer is `unknown` either way; the generic is for caller convenience.

## Remember pattern

The most common shape: "get this value, or compute and cache."

```ts
const trending = await cache.remember('leads.trending', '5m', async () => {
  return await leads.query().orderBy('score', 'desc').limit(10).get()
})
```

1. Try `get(key)`.
2. If hit, return it.
3. If miss, call `fn()`, store the result with the TTL, return it.

`rememberForever(key, fn)` omits the TTL — the entry persists until `forget` / `flush`.

The base class implements both `remember` and `rememberForever` on top of `get` + `put`, so every driver behaves identically here.

## Atomic operations

```ts
await cache.increment('hits:home', 1)
await cache.decrement('inventory:sku-1', 1)

const acquired = await cache.add('lock:job-99', '1', '60s')   // true only if absent
```

- `increment` / `decrement` are atomic on Postgres (single `INSERT … ON CONFLICT DO UPDATE` with row lock). On Memory, the per-process Map is updated under no JS-level race because Bun's event loop is single-threaded — fine for dev.
- `add(key, value, ttl)` is put-if-absent: returns `true` if stored, `false` if a fresh value was already there. Atomic on both drivers.

If a counter row exists but expired, increment / decrement reset to the delta and clear the TTL — treating expired rows as missing. The MemoryCache test suite documents the exact behaviour.

## Locks (distributed mutex)

For "only one worker does this":

```ts
const lock = cache.lock('reindex', '5m')

if (await lock.acquire()) {
  try {
    await reindex()
  } finally {
    await lock.release()
  }
} else {
  log.info('reindex skipped — another worker has the lock')
}
```

Or with `block`:

```ts
await cache.lock('reindex', '5m').block(30_000, async () => {
  await reindex()
})
```

`block(timeoutMs, fn)` polls `acquire()` until it succeeds, runs `fn`, then `release()`s. On timeout it throws `CacheLockTimeoutError`. The wait interval is 50ms on Memory, 200ms on Postgres.

Locks survive `cache.flush()` — they're a separate concept from cached values, and a holder shouldn't lose its lease because someone wanted to clear cache entries.

Locks expire automatically after their TTL — set it long enough that the holder finishes its work, short enough that a crashed holder doesn't block forever. The release path scopes on a per-acquire owner token so a slow caller whose lock already expired can't release someone else's newer lock.

PostgresCache requires a TTL on `lock(name, ttl)` — forever-locks would survive crashes and accumulate; tighten or extend as your workload requires. MemoryCache accepts `null` (forever) but the lock dies with the process anyway.

## Tagged cache

Group keys by tag for bulk invalidation:

```ts
await cache.tags('user:42', 'leads').put('combined-report', data, '1h')
await cache.tags('user:42').flush()              // drops combined-report + anything else tagged user:42
```

Both drivers support tags. On Memory, two parallel maps (`key → tag-set`, `tag → key-set`) keep lookups cheap. On Postgres, a `strav_cache_tags` table joins keys to tags with an FK + cascade — deleting a cache entry takes its tag rows with it.

`tags(...).flush()` returns the number of keys removed.

Re-tagging a key swaps its tag set (the old tags are dropped first), so `cache.tags('v2').put('config', ...)` after `cache.tags('v1').put('config', ...)` means a `v1` flush won't touch the entry.

## Multi-node — Postgres backplane

Two changes vs. the dev wiring:

1. Register `PostgresCacheProvider` instead of `CacheProvider`. Both bind under the same `Cache` token.
2. Run `applyCacheMigration` in a migration's `up`.

```ts
import { PostgresCacheProvider } from '@strav/cache/postgres'

// bootstrap/providers.ts
export default [
  // ... ConfigProvider, LoggerProvider, DatabaseProvider, …
  new PostgresCacheProvider(),
]
```

```ts
// migrations/<timestamp>_create_cache.ts
import { applyCacheMigration } from '@strav/cache/postgres'

export const migration: Migration = {
  name: '20260601000000_create_cache',
  async up(db) {
    await applyCacheMigration(db)
  },
  async down(db) {
    await db.execute('DROP TABLE IF EXISTS "strav_cache_tags"')
    await db.execute('DROP TABLE IF EXISTS "strav_cache_locks"')
    await db.execute('DROP TABLE IF EXISTS "strav_cache"')
  },
}
```

### How the Postgres driver stores values

- All values go through `JSON.stringify` on the way in and land in a `jsonb` column. Bun.SQL's parameter binding for `unsafe()` requires `($N::text)::jsonb` to avoid the engine wrapping the parameter as a JSON string scalar; the driver handles this internally.
- On read, Bun.SQL auto-hydrates jsonb scalars to native JS types (numbers, booleans, strings, null) and returns objects/arrays as their textual JSON form. The driver detects "string that parses as JSON" vs "string that doesn't" and returns the right shape.

The cleanup sweep runs every `cleanupIntervalMs` (default 60s) and deletes expired rows + expired locks. Tune via `config.cache.cleanupIntervalMs` if you want it more or less aggressive; set to `0` to disable (useful if you run an external sweeper).

## Multi-node — Redis

```ts
import { RedisCacheProvider } from '@strav/cache/redis'

// bootstrap/providers.ts
export default [
  // ... ConfigProvider, LoggerProvider, …
  new RedisCacheProvider(),
]
```

```ts
// config/cache.ts
export default {
  driver: 'redis',
  url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  prefix: 'myapp:',                  // optional; default 'strav:'
} satisfies RedisCacheConfig
```

Uses Bun's built-in `RedisClient` (since Bun 1.2) — no third-party Redis client dependency. Atomic ops map to native Redis commands (`INCRBY`/`DECRBY`/`SET NX EX`). Tagged invalidation rides on Redis Sets (`SADD`/`SREM`/`SMEMBERS`) keyed by `<prefix>tag:<tag>` so multiple apps sharing one Redis DB don't collide. `flush()` uses `SCAN MATCH <prefix>*` + batched `DEL` — never `FLUSHDB`, which would wipe other apps' keys.

Locks use Stripe-style `SET NX EX` with a per-acquire owner token. Release uses a Lua `EVAL` that compares the stored owner to the calling holder's token and deletes only on match — same race-free pattern Redis docs recommend.

## Multi-node — Memcached

```ts
import { MemcachedCacheProvider } from '@strav/cache/memcached'

// bootstrap/providers.ts
export default [
  // ... ConfigProvider, LoggerProvider, …
  new MemcachedCacheProvider(),
]
```

```ts
// config/cache.ts
export default {
  driver: 'memcached',
  host: process.env.MEMCACHED_HOST ?? '127.0.0.1',
  port: Number(process.env.MEMCACHED_PORT ?? '11211'),
  prefix: 'myapp:',                  // optional; default 'strav:'
} satisfies MemcachedCacheConfig
```

Uses a minimal Memcached text-protocol client over `Bun.connect` — no third-party Memcached client dependency. The protocol is older + simpler than Redis; the package implements only what `Cache` needs (`get`/`set`/`add`/`delete`/`incr`/`decr`/`flush_all`).

**Limitations** the driver inherits from Memcached:

- **`tags()` throws `CacheDriverError`.** Memcached has no native sets and no SCAN equivalent, so tagged invalidation isn't implementable without an expensive full-server scan per flush. Use Redis or Postgres if you need tags.
- **`flush()` is server-wide.** `flush_all` clears the entire Memcached server, not just the prefix. Don't share a Memcached instance with other apps if you ever call `flush()`.
- **Lock release has a slim race window.** Memcached's text protocol has no atomic compare-and-delete (no CAS-scoped DEL). The driver reads the lock's owner value then DELETEs; a concurrent acquire between those steps could result in releasing someone else's lock. Set a tight enough TTL that this rarely matters in practice — or use Redis/Postgres for strict lock ownership.

For `increment` / `decrement` on missing keys, Memcached returns `NOT_FOUND` (it can't auto-seed). The driver handles this with a `NOT_FOUND → add(delta) → retry incr` chain — same outcome as Redis but ~2 round-trips on first increment.

## When NOT to cache

- A query that takes <10ms — caching adds round-trip overhead that may dominate.
- Per-user data that hits the cache once and never again — pointless.
- Anything where stale data is dangerous (auth tokens, payment state).

## Pairs with

- **`@strav/cli`'s `cache:clear` + `cache:forget` commands** — wired against the `Cache` token, so they work with either driver. (Shipping in a follow-up CLI slice.)
- **`@strav/http`'s response-caching middleware** — `cache:public,5m,...` reads/writes through the configured `Cache`. (Shipping in a follow-up HTTP slice.)
- **`@strav/view`'s response-cache layer** — same backplane.
