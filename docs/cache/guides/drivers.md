# Drivers

Four drivers ship: Memory, Postgres, Redis, Memcached. Picking the right one is a 90% decision — it almost always falls out of "how many processes share this cache?" and "do you already run the backing service?"

| Driver | Subpath | Cross-process | Atomic ops | Locks | Tags | When |
|---|---|---|---|---|---|---|
| Memory | `@strav/cache` root | ❌ single process | ✅ (single-threaded JS) | ✅ in-process | ✅ | Dev, tests, single-node single-process apps |
| Postgres | `./postgres` | ✅ | ✅ (row locks) | ✅ (owner-scoped DELETE) | ✅ (join table + cascade) | You already run Postgres |
| Redis | `./redis` | ✅ | ✅ (INCRBY) | ✅ (Lua compare-and-delete) | ✅ (Sets) | Performance matters; you accept a third service |
| Memcached | `./memcached` | ✅ | ✅ (incr + add seed) | ⚠️ race window on release | ❌ throws | Legacy ops setup; pure key/value workload |

## Decision tree

```
Single process? ─────────────► Memory
        │
        no
        │
Already running Postgres? ───► Postgres  (one less service to operate)
        │
        no
        │
Need sub-millisecond reads? ─► Redis
        │
        no
        │
Stuck with legacy Memcached? ► Memcached  (otherwise default Postgres)
```

Postgres is the "and you have one less service" answer. The polling-style isn't an issue for cache — atomic operations run as single statements; latency is whatever your DB round-trip is (typically <1ms in-region).

Redis wins when you need sub-millisecond reads at high throughput. The cost is operational: another service to monitor, version, back up (or accept that it's ephemeral), and reason about during incidents.

Memcached is the right answer when you already have a Memcached cluster from a prior generation of your stack. Greenfield projects almost never pick it over Redis or Postgres.

## Memory

```ts
import { CacheProvider } from '@strav/cache'

// bootstrap/providers.ts
export default [
  new ConfigProvider({ /* ... */ }),
  new CacheProvider(),
]
```

No config required. Defaults are sane. Optional config:

```ts
// config/cache.ts
export default {
  driver: 'memory',
  // now?: () => number — only useful in tests for deterministic TTLs
} satisfies MemoryCacheConfig
```

The driver uses a single `Map<string, CacheEntry>` for entries plus parallel maps for locks and tag indexes. Reads are O(1); TTL expiry happens on the read path (no background sweep). For dev / tests / single-process deployments, it's the right answer — zero ops, fastest reads, full surface support.

**Limits worth knowing:**

- **No memory cap by default.** Apps that cache a lot without a TTL grow without bound. Apply TTLs on `put` even when you don't strictly need them.
- **Lost on restart.** Cold cache after every deploy. Fine for short-TTL workloads, painful if you rely on long-lived entries.
- **Single-process.** Two app servers see two separate caches. The moment you scale horizontally, switch drivers.

## Postgres

```ts
import { PostgresCacheProvider, applyCacheMigration } from '@strav/cache/postgres'

// bootstrap/providers.ts
export default [
  new ConfigProvider({ /* ... */ }),
  new DatabaseProvider(),
  new PostgresCacheProvider(),
]
```

```ts
// config/cache.ts
import type { PostgresCacheConfig } from '@strav/cache/postgres'

export default {
  driver: 'postgres',
  cleanupIntervalMs: 60_000,    // expired-row sweep cadence; 0 to disable
} satisfies PostgresCacheConfig
```

```ts
// migrations/<timestamp>_create_cache.ts
import { applyCacheMigration } from '@strav/cache/postgres'

export const migration: Migration = {
  name: '20260601_create_cache',
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

Three tables: `strav_cache`, `strav_cache_locks`, `strav_cache_tags` (with FK cascade on the tag → cache key relation). Every operation maps to a single SQL statement. Locks use `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now() RETURNING owner` so contention serialises at the row lock; tagged invalidation is a single `DELETE FROM strav_cache WHERE key IN (SELECT key FROM strav_cache_tags WHERE tag = ANY(...))`.

**Why pick Postgres:**

- **You already operate Postgres.** No new service. Backups, monitoring, alerting, on-call — everything you already have for the DB covers the cache too.
- **Strong consistency.** Atomic ops are transactional; locks have race-free release; tagged invalidation is atomic (CASCADE on the join table).
- **No memory limits.** Bounded by Postgres' disk; the sweep loop deletes expired rows continuously.

**Limits:**

- **Latency.** A single round-trip to Postgres is ~0.5–1ms in-region — fine for most reads, an issue if you're trying to hit the cache 50× per request.
- **DB load.** Cache reads run against the same Postgres instance as your other queries. If the cache hits N times per request and your app does 1000 req/sec, that's N × 1000 statements/sec on Postgres. Heavy users sometimes run a separate Postgres for the cache to avoid bleed.
- **Cleanup cadence.** Expired rows linger until the sweep runs. Tune `cleanupIntervalMs` (default 60s) tighter if you store many short-TTL counters; set to 0 and run an external sweeper if you prefer.

### Operations

- **Backups** — the cache contents are reproducible by re-reading from source-of-truth. Most apps exclude `strav_cache*` tables from backups.
- **Vacuum** — the sweep DELETEs leave dead tuples. Postgres' autovacuum handles them, but for high-churn caches (millions of expirations per day), tune the per-table autovacuum thresholds:

```sql
ALTER TABLE strav_cache SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 1000
);
```

- **Index health** — the schema's two indexes (PK on `key`, partial on `expires_at`) are tiny relative to typical app indexes. No special maintenance.

## Redis

```ts
import { RedisCacheProvider } from '@strav/cache/redis'

// bootstrap/providers.ts
export default [
  new ConfigProvider({ /* ... */ }),
  new RedisCacheProvider(),
]
```

```ts
// config/cache.ts
import type { RedisCacheConfig } from '@strav/cache/redis'

export default {
  driver: 'redis',
  url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  prefix: 'myapp:',            // optional; default 'strav:'
} satisfies RedisCacheConfig
```

Uses Bun's built-in `RedisClient` — no third-party dep. Atomic ops map to native commands; locks use `SET NX EX` + Lua compare-and-delete release; tags ride on Redis Sets keyed by prefix.

**Why pick Redis:**

- **Speed.** Sub-millisecond reads at 100k+ ops/sec per node. The right answer when your cache is on the critical path of every request.
- **Mature surface.** Native data structures (sets, lists, sorted sets) cover edge cases. Pub/Sub, Streams, expirations as first-class concepts.
- **Operational ecosystem.** Managed Redis (AWS ElastiCache, Upstash, Redis Cloud) exists; tooling is well-documented.

**Limits:**

- **Another service.** Operational overhead — you watch one more process. Worth it when latency matters.
- **Memory-bounded.** Redis enforces `maxmemory` with an eviction policy (LRU / LFU / TTL-only). Configure it on the server side — the cache driver doesn't enforce anything.
- **Persistence.** AOF + RDB are configurable on the Redis side; the cache driver treats Redis as ephemeral. For "cache survives restart", use Redis' AOF mode. For "we'll rebuild on restart", run Redis without persistence and accept the cold start.

### `flush()` and shared databases

The driver's `flush()` uses `SCAN MATCH <prefix>* COUNT 500` + batched `DEL`. It will NOT use `FLUSHDB` — apps sharing a Redis DB across multiple use cases would lose unrelated keys.

If you run a dedicated Redis for the framework's cache, `FLUSHDB` is faster than `SCAN`; you can call it via `client.send('FLUSHDB', [])` if you need the speed and own the database.

### Operations

- **Memory** — set `maxmemory` and `maxmemory-policy allkeys-lru` (or `allkeys-lfu` for skewed access). Without it, Redis OOMs eventually.
- **Persistence** — disable for ephemeral cache (faster, smaller risk of long fsync stalls); enable AOF (`appendonly yes`) for "warm cache survives restart" semantics.
- **Sharding** — Redis Cluster handles sharding transparently. Bun's `RedisClient` works with Cluster mode via the standard `cluster://` URL scheme.

## Memcached

```ts
import { MemcachedCacheProvider } from '@strav/cache/memcached'

// bootstrap/providers.ts
export default [
  new ConfigProvider({ /* ... */ }),
  new MemcachedCacheProvider(),
]
```

```ts
// config/cache.ts
import type { MemcachedCacheConfig } from '@strav/cache/memcached'

export default {
  driver: 'memcached',
  host: process.env.MEMCACHED_HOST ?? '127.0.0.1',
  port: Number(process.env.MEMCACHED_PORT ?? '11211'),
  prefix: 'myapp:',
} satisfies MemcachedCacheConfig
```

Uses a minimal text-protocol client over `Bun.connect` — no third-party dep. Single TCP connection, FIFO request queue.

**Why pick Memcached:**

- **Existing infrastructure.** You have a Memcached cluster from a prior generation; ripping it out costs more than working with it.
- **Pure key/value workload.** Your cache is "GET key, SET key with TTL" — none of Redis' richer data structures help.

**Limits the driver inherits from the protocol:**

- **`tags()` throws.** Memcached has no native sets or SCAN; emulating tags would require server-wide scans per flush.
- **`flush()` is server-wide.** No prefix-scoped flush. Don't share a Memcached instance with other apps if you ever call `flush()`.
- **Lock release race window.** No CAS-scoped DELETE in the text protocol. The driver reads + compares + deletes, with a slim window where a concurrent acquire could result in releasing someone else's lock. Set tight TTLs or use Redis/Postgres for strict ownership.
- **No multi-key GET.** Single-key operations only; bulk reads issue N round-trips.

If you're picking new infrastructure, pick Postgres or Redis. The framework supports Memcached because real apps deploy onto inherited stacks; "greenfield Memcached" is increasingly rare.

## Switching drivers

The contract is identical across drivers — switching is a provider swap + config change. No app code touches the driver type.

Migration order:

1. **Implement against Memory in dev.** Fast iteration.
2. **Move to Postgres in staging + prod.** No new service. Catch tag / lock semantics issues early.
3. **Upgrade to Redis if performance demands.** Profile first — most apps don't hit Postgres' ceiling for cache workloads.

The reverse (Redis → Postgres) is rare but supported. The work is the provider swap; runtime data doesn't migrate (caches are reproducible).

## Multi-driver setups

Most apps run one cache driver. Cases where you might run two:

- **L1 + L2.** Memory in-process for hot reads, Redis as the shared backplane. Implement as a custom `Cache` that reads Memory first, falls through to Redis on miss, populates Memory on the way back. Not shipped by the framework — apps that need it write the ~50 LOC themselves.
- **Per-region cache.** Each region has a local Redis + a global Postgres for cross-region consistency. Apps wire two `Cache` instances behind named tokens.

The framework doesn't try to abstract these — the right shape depends on your topology. Reach for them if profiling shows the single-driver model is the bottleneck.

## Driver-specific config reference

| Option | Memory | Postgres | Redis | Memcached |
|---|---|---|---|---|
| Connection | — | (via `Database` token) | `url` | `host` + `port` |
| Prefix | — | (table name fixed) | `prefix` (default `'strav:'`) | `prefix` (default `'strav:'`) |
| Cleanup cadence | — | `cleanupIntervalMs` | (Redis EXPIRE handles) | (Memcached TTL handles) |
| Buffer / overflow | (n/a — see `subscriberCount`) | (n/a) | (Redis-side `maxmemory`) | (Memcached-side `-m` flag) |
| Timeouts | — | (via `Database`) | (Bun.RedisClient default) | `connectTimeoutMs` + `requestTimeoutMs` |

For the precise option types, see the [api.md](../api.md) reference.
