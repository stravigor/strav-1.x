# Patterns

Four shapes cover most cache use cases. Reach for the one that matches your read/write profile rather than picking from a menu — the wrong pattern is usually how cache layers turn into bugs.

| Pattern | When | Risk |
|---|---|---|
| **Cache-aside via `remember`** | Read-heavy, value expensive to compute, stale-tolerable | Stampede when many readers miss simultaneously |
| **Write-through** | Read + write balanced, consistency between writes and reads matters | Doubles write latency; cache + DB can diverge on failure |
| **Atomic counters via `increment`** | Hot counters (rate-limits, view counts, queue stats) | Lost updates on Memory driver across processes |
| **Distributed locks via `lock`** | "Only one worker does this at a time" — reindex, cache rebuild | Forgotten release → blocked work until TTL expires |

The `remember` pattern is the default. Reach for write-through when consistency matters; reach for locks when you need cross-process mutual exclusion.

## Cache-aside via `remember`

The most common shape — "get this value, or compute and cache it":

```ts
const trending = await this.cache.remember('leads.trending', '5m', async () => {
  return this.leads.query().orderBy('score', 'desc').limit(10).get()
})
```

What happens:

1. `get(key)` → if hit, return.
2. If miss, call the closure, store the result with the TTL, return.

The base class implements `remember` on top of `get` + `put`, so every driver behaves identically here. The closure runs ONCE per cache miss in a single process; across processes (and within the same process if you don't deduplicate), it can run multiple times concurrently — see "Stampede protection" below.

### Picking a TTL

The TTL is a freshness budget — "I'll tolerate data this stale to save the recomputation cost." Useful values:

| TTL | When |
|---|---|
| `'30s'` – `'2m'` | Hot reads, data changes minute-to-minute (counts, recent activity) |
| `'5m'` – `'15m'` | Most cache-aside reads (leaderboards, trending lists, dashboards) |
| `'1h'` – `'6h'` | Slow-changing data (currency rates, content lookups) |
| `'12h'` – `'24h'` | Effectively static within a day (translation tables, country codes) |
| `null` / `rememberForever` | Truly immutable per key (compiled template, hashed asset URL) |

Avoid the "round number" reflex (`5m`, `1h`) when traffic patterns suggest something else. A 5-minute TTL on a heavily-read endpoint creates a synchronized expiry every 5 minutes — every node refetches at once. Adding 30s of jitter to the TTL (`5m + Math.random() * 30s`) spreads the storm.

### `rememberForever` and explicit invalidation

When the value never changes by time — only by an event — use `rememberForever`:

```ts
const country = await this.cache.rememberForever(`country:${code}`, async () => {
  return this.countries.findByCode(code)
})
```

Pair with explicit `cache.forget(key)` on the events that invalidate. See [`invalidation.md`](./invalidation.md) for the patterns.

## Stampede protection

The single biggest cache-aside bug: N readers miss simultaneously, all run the closure, and you've hammered the backing store with the same expensive query.

The fix is a lock around the recomputation:

```ts
async function rememberWithLock<T>(
  cache: Cache,
  key: string,
  ttl: CacheTtl,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await cache.get<T>(key)
  if (cached !== null) return cached

  const lock = cache.lock(`lock:${key}`, '30s')
  return lock.block(15_000, async () => {
    // Re-check after acquiring — another holder may have populated it.
    const recheck = await cache.get<T>(key)
    if (recheck !== null) return recheck
    const fresh = await fn()
    await cache.put(key, fresh, ttl)
    return fresh
  })
}
```

Three things to notice:

- **Lock name shares the cache key.** Different cache entries have different locks, so a slow `trending` rebuild doesn't block the `popular` rebuild.
- **Re-check after acquiring.** The lock serialises the rebuild; if you were second in line, the first caller already populated the key — you should hit, not redo the work.
- **Bounded wait via `block(15_000)`.** If the rebuild takes longer than your wait window, throw `CacheLockTimeoutError` rather than stacking up requests waiting on the lock.

The default `remember` doesn't do this — apps that need stampede protection wrap their own helper. Most apps don't need it; reach for the lock pattern when:

- The closure takes >100ms (cumulative latency from a thundering herd is user-visible).
- The backing query is expensive (queries an analytics DB, makes external API calls, etc.).
- Traffic is high (>10 RPS to the same key).

## Write-through

When you write a value, write it to both the cache and the source-of-truth at the same time:

```ts
async update(id: string, patch: Partial<User>): Promise<User> {
  const updated = await this.db.transaction(async (tx) => {
    return this.users.update(tx, id, patch)
  })
  await this.cache.put(`user:${id}`, updated, '1h')
  return updated
}
```

Why this matters: if the next read happens immediately, it sees the just-written value, not a stale cache hit.

Two pitfalls:

- **The cache write can fail.** Wrap in try/catch and log — better stale reads than a 5xx because Redis was flaky.
- **The cache write happens after the DB commit.** If your process crashes between the commit and the cache write, the cache becomes stale. Reads that hit the cache see old data until the TTL expires. The cure is a short TTL on write-through caches (`5m`–`15m`), so divergence self-heals.

For consistency-critical paths (auth tokens, payment state), don't cache at all. Cache the slow lookups (user profile, settings); fetch the critical bits fresh every time.

## Atomic counters via `increment` / `decrement`

For counters that many callers update simultaneously — rate limits, view counts, "items in cart" tallies:

```ts
// In a middleware that limits to N requests per minute per IP:
const count = await this.cache.increment(`ratelimit:${ip}`)
if (count === 1) {
  // First increment — set the expiry so the bucket resets after a minute.
  await this.cache.put(`ratelimit:${ip}:expires`, true, '60s')
}
if (count > 60) {
  return ctx.response.json({ error: 'rate limited' }, { status: 429 })
}
```

The `increment` and `decrement` ops are atomic at the driver layer — concurrent callers see consistent semantics. Postgres uses an `INSERT … ON CONFLICT DO UPDATE`; Redis uses `INCRBY`; Memcached uses `incr` with a seed-via-`add` fallback for missing keys.

A common pattern: combine `increment` + `add` to set the TTL exactly once:

```ts
const seeded = await this.cache.add(`bucket:${ip}`, 1, '60s')
const count = seeded ? 1 : await this.cache.increment(`bucket:${ip}`)
```

`add` is put-if-absent; it's atomic, so even with concurrent callers, exactly one wins the seed.

### Numeric limits

- `MemoryCache.increment` is atomic *within one process* (Bun is single-threaded). Across processes it's not — pick `Postgres` / `Redis` / `Memcached` for cross-process counters.
- Values larger than `Number.MAX_SAFE_INTEGER` (≈9×10¹⁵) overflow silently. For counters that could plausibly hit that range, store as strings and parse explicitly.
- `decrement` on a key that's already 0 returns -1 on Memory / Postgres / Redis. Memcached refuses to go below 0 once seeded — handle in your app code if it matters.

## Distributed locks via `lock`

For "only one worker rebuilds this index" / "only one node runs the nightly job":

```ts
const lock = this.cache.lock('reindex', '5m')

if (await lock.acquire()) {
  try {
    await this.reindex()
  } finally {
    await lock.release()
  }
} else {
  this.log.info('reindex skipped — another worker has the lock')
}
```

Or the `block` shape, which waits up to a window for the lock to free:

```ts
await this.cache.lock('reindex', '5m').block(30_000, async () => {
  await this.reindex()
})
```

`block(timeoutMs, fn)` polls `acquire()` until it succeeds, runs `fn`, then `release()`s. On timeout throws `CacheLockTimeoutError`. The polling interval is 50ms on Memory, 200ms on Postgres / Redis.

### TTL strategy

Locks expire after their TTL. Set it long enough that the holder finishes its work, short enough that a crashed holder doesn't block forever:

| Job duration | Lock TTL |
|---|---|
| Seconds (cache rebuild) | `'30s'` – `'2m'` |
| Minutes (data import) | `'5m'` – `'15m'` |
| Hours (full reindex) | `'1h'` – `'2h'` |
| Unbounded | Don't use locks — restructure into batches. Forever-locks across processes accumulate on crashes. |

`PostgresCache.lock` and `RedisCache.lock` refuse a `null` TTL with `CacheConfigError`. `MemoryCache.lock` allows it but the lock dies with the process anyway.

### Lock ownership

Release scopes on the per-acquire owner token — a slow caller whose lock already expired can't release someone else's newer lock. The Postgres driver uses `(name, owner)` in the DELETE; the Redis driver uses a Lua `EVAL` that compares-and-deletes. The Memcached driver does a `get` + compare + `delete`, which has a slim race window — document this and prefer Redis/Postgres for strict ownership.

`acquire()` returns true ONCE per `CacheLock` instance — calling it again on the same lock returns false (even if you're the holder). Locks are use-once: acquire, do work, release, drop the reference.

## Tagged invalidation

When you have N cache entries that share an invalidation source — "every report that references user 42" — tag them and flush by tag:

```ts
await this.cache.tags('user:42', 'leads').put('combined-report', data, '1h')
await this.cache.tags('user:42').put('profile', user, '1h')

// On user-update:
await this.cache.tags('user:42').flush()    // both entries gone
```

Two parallel maps under the hood (key→tag-set, tag→key-set):
- On `put`, both maps update.
- On `flush(...tags)`, walk each tag's key-set, delete the keys.

`MemoryCache.tags` is in-process; `PostgresCache.tags` uses a join table with FK cascade; `RedisCache.tags` uses Redis Sets. `MemcachedCache.tags()` throws — the protocol has no native sets or SCAN.

### When to tag

Tag groups of keys that share invalidation triggers. The classic example: per-user views.

```ts
// Cache every view that depends on user data with the user-id tag:
await this.cache.tags(`user:${userId}`).put(`profile:${userId}`, profile)
await this.cache.tags(`user:${userId}`).put(`dashboard:${userId}`, dashboard)
await this.cache.tags(`user:${userId}`).put(`prefs:${userId}`, prefs)

// On user.updated event, one call invalidates all three:
await this.cache.tags(`user:${userId}`).flush()
```

Don't over-tag — every tag costs a write to its key-set. Tags are best when:
- Many entries share the invalidation trigger.
- The exact key list is hard to enumerate at invalidation time.
- The invalidation happens often enough that explicit `forget(key)` per entry would be tedious.

If you only have one or two keys that need invalidation, just call `forget()` directly.

## Composite patterns

Real apps combine these:

**Cache-aside + tagged invalidation** — the trending list is rebuilt on miss, AND flushed when any underlying lead changes:

```ts
await this.cache.tags('leads:all').put('leads.trending', trendingList, '5m')

// In the lead-update event listener:
this.events.on('lead.updated', () => {
  return this.cache.tags('leads:all').flush()
})
```

**Lock-protected rebuild + tagged invalidation** — combines stampede protection with explicit invalidation:

```ts
async getTrending(): Promise<Lead[]> {
  return rememberWithLock(this.cache, 'leads.trending', '5m', async () => {
    const list = await this.leads.queryTopByScore()
    await this.cache.tags('leads:all').put('leads.trending', list, '5m')
    return list
  })
}
```

The `tags(...).put` happens inside the locked rebuild; subsequent flush events drop the entry properly. The straight `cache.put` inside `remember` wouldn't carry the tags.

## Anti-patterns

**Caching every database read.** The cache is a tool for specific reads (expensive, hot, stale-tolerable). Caching every read because "the cache makes things faster" piles on complexity (invalidation bugs, stale data, debugging "why isn't my change showing up") and rarely helps — Postgres' shared buffers already cache recent reads.

**Long TTL + no invalidation.** A 24-hour TTL on data that changes hourly means up to a 23-hour stale window. Either shorten the TTL or wire explicit invalidation.

**Cache layer in front of a cache.** Don't cache Postgres reads where Postgres is already caching them in shared buffers, and don't cache CDN-cached responses. Pick one cache; the second layer adds latency without adding speed.

**Storing references not values.** `cache.put('user:42', { id: 42 })` (without the loaded data) is useless — readers still need to fetch the actual user, defeating the cache. Store the materialised result, not a pointer.

**Mutating cached objects.** If you `cache.get<User>('user:42')` and then mutate the returned object, every other caller holding the same reference sees the mutation. `MemoryCache` returns the actual stored reference; `Postgres` / `Redis` / `Memcached` round-trip through JSON so this isn't a problem there — but writing code that depends on the difference is brittle. Treat cached values as immutable.
