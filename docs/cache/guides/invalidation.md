# Invalidation

"There are only two hard things in Computer Science: cache invalidation and naming things." — Phil Karlton, 1996.

Naming has gotten easier. Cache invalidation has not. Four strategies cover the field; pick the one that matches how the underlying data actually changes.

| Strategy | When to use | Drawback |
|---|---|---|
| **TTL-based** | Data changes regularly, brief staleness acceptable | Stale window = up to TTL on every entry |
| **Event-based** | Writes are observable + you control all of them | Bug surface area (forgotten invalidations) |
| **Tag-based** | Many keys share an invalidation trigger | Tag bookkeeping has cost; not all drivers support |
| **Versioned keys** | Massive invalidations (deploy-triggered, schema rev) | New code only, old keys expire on TTL |

Most real apps combine two or three. Pure TTL works for prototypes; production usually layers event-based on top.

## TTL-based

Set a TTL; let the entry expire on its own.

```ts
await cache.remember('leads.trending', '5m', () => leads.queryTopByScore())
```

**When TTL alone is enough:**

- The data changes regularly (every few minutes or faster).
- "Up to N minutes stale" is acceptable to users.
- Writes are infrequent relative to reads (write-once-read-many).

The reasoning is "good enough" — readers see slightly stale data for at most one TTL window, then the system self-heals. No invalidation bugs because there's no invalidation code.

**When TTL alone breaks:**

- Writes are observable and "the user just clicked save" must show fresh data on the next read. TTL invalidation feels broken to users in that case.
- The data is essentially-immutable (translations, country codes, currency lookups) — TTL just causes spurious refetches.

### Picking the TTL

A 5-minute TTL on a popular endpoint means:

- p50 staleness: 2.5 minutes.
- p99 staleness: ~5 minutes.
- Coordinated refetch every 5 minutes on a synchronized boundary.

The last point is the gotcha. If every cache entry has a 5-minute TTL set at app boot, every entry expires at the same instant, and every reader misses simultaneously. Add jitter:

```ts
function jitteredTtl(base: number, jitterRatio = 0.1): number {
  return base + Math.floor(Math.random() * base * jitterRatio)
}

await cache.put('leads.trending', list, jitteredTtl(5 * 60))   // 300–330s
```

10% jitter is usually plenty. The Redis driver (in particular) handles synchronized expiry better than naive in-memory caches because expirations spread across the IO loop, but for very hot keys + multi-node deployments, jitter still helps.

## Event-based

Invalidate on the same write that changes the data:

```ts
async update(id: string, patch: Partial<User>): Promise<User> {
  const updated = await this.users.update(id, patch)
  await this.cache.forget(`user:${id}`)
  return updated
}
```

Most apps wrap this with an event bus so the cache and the write are decoupled:

```ts
class CacheInvalidator {
  constructor(private readonly cache: Cache) {}

  register(events: EventBus): void {
    events.on('user.updated', async ({ user }: { user: User }) => {
      await this.cache.forget(`user:${user.id}`)
    })
    events.on('lead.updated', async ({ lead }: { lead: Lead }) => {
      await this.cache.forget(`lead:${lead.id}`)
      // Trending depends on every lead, so flush that too.
      await this.cache.forget('leads.trending')
    })
  }
}
```

Two pitfalls:

- **Forgotten cascades.** When `lead.updated` invalidates the lead itself, it should also invalidate `leads.trending`, the user's `dashboard:U` view, and any team summaries that include this lead. Missing one → readers see stale data forever (until the TTL safety net). Tag-based invalidation is the framework's answer.
- **Event-bus failures.** If the event fires but the cache invalidation throws (Redis is flaky), you've successfully written to the DB but left a stale cache entry. Two mitigations: short TTL as a safety net (the stale window is bounded), or retry the invalidation via the queue (`queue.dispatch(InvalidateCache, { key })`).

### Combining with TTL

The standard belt-and-suspenders approach: event-based invalidation + a TTL as backstop. Most reads get fresh data via event-based; the rare missed invalidation auto-heals when the TTL fires.

```ts
await cache.remember(`user:${id}`, '15m', () => users.find(id))
// Event listener:
events.on('user.updated', ({ user }) => cache.forget(`user:${user.id}`))
```

A 15-minute TTL means even if the event-based path breaks (refactor accident, infra glitch), the worst-case staleness is 15 minutes — recoverable.

## Tag-based

For groups of keys with shared invalidation triggers — see [`patterns.md`](./patterns.md) for the mechanics.

```ts
// Many entries share the user:42 tag:
await cache.tags('user:42').put('profile:42', profile, '1h')
await cache.tags('user:42').put('dashboard:42', dashboard, '1h')
await cache.tags('user:42').put('prefs:42', prefs, '1h')

// One flush invalidates all three:
events.on('user.updated', ({ user }) => cache.tags(`user:${user.id}`).flush())
```

When tag-based wins over event-based:

- The cascade is **wide** (10+ keys per event). Listing them all in the event handler turns into "what did I forget?" risk.
- The cascade is **dynamic** (which keys depend on this entity isn't statically knowable). E.g. "every cached report that references user 42" — you don't know the report keys at write time.
- The invalidation happens **often** enough that the per-entry `forget()` calls become tedious.

Driver support: Postgres + Redis + Memory have full tag support. Memcached throws on `tags()` — there's no native sets or SCAN in the protocol.

### Tag granularity

Tags work best when they map to entities ("user:42", "tenant:acme"), not categories ("all caches", "frontend"). Coarse tags invalidate too much:

```ts
// BAD — every cached anything gets dropped on any user update.
await cache.tags('users').put(`user:${id}`, user, '1h')

// GOOD — each user's caches scoped independently.
await cache.tags(`user:${id}`).put(`user:${id}`, user, '1h')
```

The good shape lets `tags('user:42').flush()` invalidate user 42's caches without touching user 43's.

## Versioned keys

Don't invalidate — change the key. The old entries expire on TTL; new code writes + reads the new key.

```ts
const cacheVersion = '2'   // or pulled from app version / deploy id

const profile = await cache.remember(
  `v${cacheVersion}:user:${id}`,
  '15m',
  () => users.find(id),
)
```

When this wins:

- **Schema changed.** The cache holds the old shape; new code expects the new shape. Bumping the version means new code reads from new keys (cache miss → fresh data via the closure) while old code (still mid-deploy) reads from old keys.
- **Algorithm changed.** The trending logic now considers a different score; old cached results are wrong even at the bit level. Bump the version, let old keys expire.
- **Bulk invalidation.** Some event needs to invalidate "every cache". Instead of walking + deleting (slow), bump the version.

The trade-off: old keys persist until TTL expires. For a 15-minute TTL on the cache, that's 15 minutes of dead bytes after a deploy. Usually fine; for high-volume / long-TTL caches, run a sweep separately.

### How to set the version

The simplest: a constant in code, bumped manually when needed. The deploy ID works too:

```ts
import { config } from '@strav/kernel'

const version = config.get<string>('cache.version', '1')
```

```ts
// config/cache.ts
export default {
  driver: 'redis',
  // ...
  version: process.env.DEPLOY_ID ?? 'dev',
}
```

Bumping `DEPLOY_ID` on every deploy means every deploy bypasses cached data (cold cache after deploy). Cheap insurance against "did I forget to invalidate something for this release?" — but you also lose the perf benefit of a warm cache for the deploy window. Usually a per-feature version (incremented when YOU change the schema, not on every deploy) is the right balance.

## Cascading invalidation

When data has dependencies, invalidation cascades:

```
user.updated
├── user:42                   ← direct
├── dashboard:42              ← depends on user
├── team:99                   ← user is on team 99
└── leads.trending            ← user might have lead in trending
```

Three ways to handle:

**1. Manual list in the handler.** Tedious + error-prone but explicit:

```ts
events.on('user.updated', async ({ user }) => {
  await cache.forget(`user:${user.id}`)
  await cache.forget(`dashboard:${user.id}`)
  await cache.forget(`team:${user.teamId}`)
  await cache.forget('leads.trending')
})
```

**2. Tag-based.** Every cache entry that depends on the user is tagged with `user:42`:

```ts
events.on('user.updated', async ({ user }) => {
  await cache.tags(`user:${user.id}`).flush()
})
```

**3. Versioned keys.** Bump the user's cache version:

```ts
events.on('user.updated', async ({ user }) => {
  await cache.put(`user:${user.id}:version`, Date.now())
})

// Readers consult the version:
const version = await cache.get<number>(`user:${user.id}:version`) ?? 0
const profile = await cache.remember(`v${version}:user:${user.id}`, '15m', loadProfile)
```

Versioned keys handle the cascade implicitly — every cache key derived from `user:42`'s version flips to the new key when the version bumps. The cost is extra reads (one for the version, one for the data). Often acceptable; usually not the first choice.

## Lazy refresh

A variant of cache-aside that returns stale data immediately while triggering an async refresh:

```ts
async function getWithLazyRefresh<T>(
  cache: Cache,
  key: string,
  ttl: CacheTtl,
  fn: () => Promise<T>,
): Promise<T | null> {
  const stale = await cache.get<{ value: T; staleAt: number }>(key)
  if (stale === null) {
    const fresh = await fn()
    await cache.put(key, { value: fresh, staleAt: Date.now() + ms(ttl) / 2 })
    return fresh
  }
  if (Date.now() > stale.staleAt) {
    // Triggered async refresh — don't await.
    void (async () => {
      const fresh = await fn()
      await cache.put(key, { value: fresh, staleAt: Date.now() + ms(ttl) / 2 })
    })()
  }
  return stale.value
}
```

The returned value is up to N seconds stale, but the closure runs in the background. Users see no latency from cache misses on long-running queries; freshness lags by one refresh cycle.

Not shipped by the framework — apps that want this pattern write the ~20 LOC themselves. Useful for expensive precomputed views (analytics rollups, ML model outputs) where staleness is fine but latency must be predictable.

## When cache invalidation is the wrong question

The hardest invalidation cases are the ones where you shouldn't be caching at all:

- **Highly mutable data** with strict freshness requirements → fetch fresh every time. Postgres' shared buffers cache it for you.
- **Per-user data that's read once per session** → no caching helps; you'd cache something, then never read it again before the user logs out.
- **Cross-tenant aggregates that change minute-to-minute** → run them as materialised views in Postgres; let the database maintain them.

If you find yourself fighting invalidation logic for any one cache entry, that's a signal that the entry shouldn't be cached. Cache the expensive, hot, stale-tolerable reads; fetch the rest.

## Self-check

Before adding a cache entry, answer:

1. **What's the read frequency?** Below 10/sec it's probably not worth caching.
2. **What's the recompute cost?** Below 5ms it's probably not worth caching.
3. **What's the freshness budget?** If "must be fresh", don't cache. If "≤5 minutes" is fine, set a 5-minute TTL.
4. **How does it get invalidated?** TTL alone? Event? Tag? Versioned key?
5. **What's the failure mode?** If cache is unavailable, do reads still work (cache-aside)? Or does cache failure cascade into user-visible errors (don't do this)?

If you can't answer 4, you're adding a cache invalidation bug. Either pick a strategy explicitly or use a short TTL as a placeholder until the answer becomes clear.
