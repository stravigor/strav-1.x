# `@strav/cache` API

Public exports + semantics. Pairs with the [README](./README.md) overview.

## Root barrel — `@strav/cache`

### `class Cache`

```ts
class Cache {
  // Driver primitives — subclasses MUST override.
  get<T = unknown>(key: string, fallback?: T | null): Promise<T | null>
  put(key: string, value: unknown, ttl?: CacheTtl): Promise<void>
  has(key: string): Promise<boolean>
  forget(key: string): Promise<boolean>
  flush(): Promise<void>
  add(key: string, value: unknown, ttl: CacheTtl): Promise<boolean>
  increment(key: string, by?: number): Promise<number>
  decrement(key: string, by?: number): Promise<number>
  lock(name: string, ttl: CacheTtl): CacheLock
  tags(...tags: string[]): TaggedCache

  // Higher-level patterns — base implementation, identical across drivers.
  remember<T>(key: string, ttl: CacheTtl, fn: () => Promise<T> | T): Promise<T>
  rememberForever<T>(key: string, fn: () => Promise<T> | T): Promise<T>

  // Resource cleanup. Default no-op.
  close(): Promise<void>
}
```

Container token + abstract base. Non-`abstract` so it can serve as a singleton key (same trade-off as `kernel`'s `Logger` and `@strav/broadcast`'s `Broadcaster`); subclasses must override the primitives, the defaults throw to surface forgotten overrides during development.

**Semantics every driver guarantees:**

- `get` returns `null` (or `fallback`) for missing keys + expired entries. Expired entries are removed in passing.
- `put` overwrites. TTL parsed via `parseTtl`.
- `has` matches `get` — false for missing + expired.
- `forget` returns true iff a row was actually removed.
- `flush` drops every entry. Locks survive `flush` — they're a separate resource.
- `add` is put-if-absent. Atomic: concurrent callers get exactly one `true`. Returns `false` when a fresh row exists.
- `increment` / `decrement` start from 0 for missing keys, treat expired entries as missing (resetting + clearing the TTL), are atomic at the driver level.
- `remember` / `rememberForever` shape: `get → fn → put`. Pure base-class composition.

### `CacheLock`

```ts
interface CacheLock {
  readonly name: string
  acquire(): Promise<boolean>
  release(): Promise<boolean>
  block<T>(timeoutMs: number, fn: () => Promise<T> | T): Promise<T>
}
```

Returned by `cache.lock(name, ttl)`. `acquire` returns true once on success, false on contention; `release` returns true only when the calling holder actually held the lock (per-acquire owner token). `block` polls until success or timeout — throws `CacheLockTimeoutError` on timeout.

Locks expire automatically after their TTL. A crashed holder doesn't block forever — the next acquire after expiry wins.

### `TaggedCache`

```ts
interface TaggedCache {
  readonly tags: readonly string[]
  put(key: string, value: unknown, ttl?: CacheTtl): Promise<void>
  get<T = unknown>(key: string, fallback?: T | null): Promise<T | null>
  forget(key: string): Promise<boolean>
  flush(): Promise<number>      // returns the number of keys removed
}
```

Returned by `cache.tags(...tags)`. `put` associates the key with this namespace's tags (re-tagging swaps the set). `flush` drops every key carrying any of these tags.

### `CacheTtl`

```ts
type CacheTtl = string | number | null | undefined
```

Three forms:

- **`'10m'` / `'1h'` / `'45s'` / `'2d'`** — short-form. Suffixes: `s` / `m` / `h` / `d`. Whitespace allowed, case-insensitive. Integer values only (`'1.5m'` is NOT supported).
- **`300`** — number, interpreted as seconds.
- **`null` / `undefined`** — no expiry. Entries persist until `forget` / `flush`. PostgresCache requires a TTL for `lock()`.

`parseTtl(ttl)` returns the resolved seconds (or `null` for no expiry). `ttlToExpiresAt(ttl, now?)` returns the absolute unix-ms timestamp. Both exported for driver authors.

### Errors

- `CacheError` — base (`code: 'cache.error'`, status 500).
- `CacheConfigError` — provider boot (`code: 'cache.config'`, status 500).
- `CacheDriverError` — driver-side I/O failure (`code: 'cache.driver'`, status 502).
- `CacheLockTimeoutError` — `block()` window exhausted (`code: 'cache.lock_timeout'`, status 503).
- `CacheTtlParseError` — malformed TTL string (`code: 'cache.ttl_parse'`, status 400).

### `CacheProvider`

```ts
class CacheProvider extends ServiceProvider {
  name = 'cache'
  dependencies = ['config']
}

interface MemoryCacheConfig {
  driver: 'memory'
  now?: () => number          // deterministic clock for tests
}
```

Binds `MemoryCache` under the `Cache` token. Reads `config.cache` for the optional overrides — apps that don't configure anything get the defaults.

### `MemoryCache`

```ts
class MemoryCache extends Cache {
  constructor(options?: MemoryCacheOptions)
  size(): number              // diagnostic — total entries (incl. expired-but-not-yet-evicted)
}

interface MemoryCacheOptions {
  now?: () => number
}
```

In-process. Map-backed; locks via separate map; tags via two parallel maps (`key → tag-set`, `tag → key-set`). `close()` is a no-op.

## `@strav/cache/memory`

Re-exports `MemoryCache` + `MemoryCacheOptions` for explicit construction (when an app wires its own provider). The root barrel already exports the same symbols; the subpath exists for consistency with `@strav/cache/postgres`.

## `@strav/cache/postgres`

```ts
class PostgresCache extends Cache {
  constructor(options: PostgresCacheOptions)
  sweepOnce(): Promise<number>          // delete expired entries; returns rowcount
  sweepLocksOnce(): Promise<number>     // delete expired locks
}

interface PostgresCacheDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  execute(sql: string, params?: readonly unknown[]): Promise<number>
}

interface PostgresCacheOptions {
  db: PostgresCacheDatabase
  cleanupIntervalMs?: number     // background sweep cadence. Default 60_000. Set 0 to disable.
}

class PostgresCacheProvider extends ServiceProvider {
  name = 'cache'
  dependencies = ['config', 'database']
}

interface PostgresCacheConfig {
  driver: 'postgres'
  cleanupIntervalMs?: number
}

function applyCacheMigration(db: DatabaseExecutor): Promise<void>
```

**Wire shape.** Three tables:

```
strav_cache          (key text PK, data jsonb, expires_at timestamptz NULL)
strav_cache_locks    (name text PK, owner text, expires_at timestamptz)
strav_cache_tags     (key text, tag text, PK (key,tag), FK → strav_cache(key) ON DELETE CASCADE)
```

Indexes:

- Partial `(expires_at)` on `strav_cache` for the cleanup sweep.
- `(tag)` on `strav_cache_tags` for the flush path.

**Atomic semantics:**

- `add` uses `INSERT … ON CONFLICT DO UPDATE WHERE expires_at <= now() RETURNING 1` so concurrent callers see exactly one `true`.
- `increment` / `decrement` use a single `INSERT … ON CONFLICT DO UPDATE` with a `CASE` expression to handle missing / fresh / expired uniformly. Concurrent increments serialize at the row lock; the final value reflects every call.
- `lock.acquire` uses the same upsert pattern against `strav_cache_locks`. Release scopes on `(name, owner)` so a slow caller can't release someone else's newer lock.

**Why not register schemas with `SchemaRegistry`?** The schema DSL doesn't have a "text PK" helper, and the tags table needs a composite PK. The migration helper emits the DDL directly; apps don't need the registry entries for anything else (the driver hard-codes the table names from string constants).

**Value serialization.** Bun's `SQL` binding behaves differently from naive expectations: passing a JSON-stringified value to `$N::jsonb` wraps the value as a JSON string scalar regardless of its actual JSON shape. The driver uses `($N::text)::jsonb` to force the cast through `text` first; that round-trips numbers / objects / strings correctly. On read, Bun's `SQL` auto-hydrates jsonb scalars to native JS types and returns objects/arrays as JSON-encoded text — the driver detects which and either returns directly or `JSON.parse`s.

**Errors.** Same hierarchy as the root barrel. `lock(name, ttl)` with `ttl === null` throws `CacheDriverError` — forever-locks across the cross-process boundary would survive crashes and accumulate.

## `@strav/cache/redis`

```ts
class RedisCache extends Cache {
  constructor(options: RedisCacheOptions)
}

interface RedisCacheOptions {
  url: string                                   // 'redis://host:port' or 'rediss://…'
  prefix?: string                               // default 'strav:'
  client?: RedisClient                          // pre-constructed Bun.RedisClient for tests
}

class RedisCacheProvider extends ServiceProvider {
  name = 'cache'
  dependencies = ['config']
}

interface RedisCacheConfig {
  driver: 'redis'
  url: string
  prefix?: string
}
```

Uses Bun's built-in `RedisClient` (`bun:redis`). No third-party Redis client dependency.

**Operation mapping:**

| Cache method | Redis command(s) |
|---|---|
| `get` | `GET key` → JSON.parse with non-JSON-string fallback |
| `put` | `SET key value [EX seconds]` |
| `has` | `EXISTS key` |
| `forget` | `DEL key` + `DEL <prefix>tagged:<key>` (clears tag wiring) |
| `flush` | `SCAN MATCH <prefix>* COUNT 500` + batched `DEL` — never `FLUSHDB` |
| `add` | `SET key value NX [EX seconds]` |
| `increment` / `decrement` | `INCRBY` / `DECRBY` |
| `lock.acquire` | `SET <prefix>lock:<name> <owner> NX EX <ttl>` |
| `lock.release` | Lua `EVAL` that compares stored value to owner token and `DEL`s on match |
| `tags(...).put` | put + sync `<prefix>tagged:<key>` Set membership + add to `<prefix>tag:<tag>` Sets |
| `tags(...).flush` | walk each tag's `SMEMBERS`, batched `DEL` keys + the tag-index sets |

**Locks.** `SET NX EX` is the canonical atomic lock primitive. Release uses Lua compare-and-delete so a slow caller whose lock already expired can't release a newer holder's lock.

**Tags.** Two parallel Redis Sets per tagged key — `<prefix>tag:<tag>` is the tag→keys index used by flush, `<prefix>tagged:<key>` is the per-key tag list used to swap tags cleanly on re-tag.

**Errors.** `lock(name, null)` throws `CacheConfigError` (no forever-locks across processes).

## `@strav/cache/memcached`

```ts
class MemcachedCache extends Cache {
  constructor(options: MemcachedCacheOptions)
}

class MemcachedClient {
  constructor(options: MemcachedClientOptions)
  send(command: string | Uint8Array): Promise<Uint8Array>
  close(): Promise<void>
}

interface MemcachedCacheOptions {
  host: string
  port: number
  prefix?: string                  // default 'strav:'
  connectTimeoutMs?: number        // default 5000
  requestTimeoutMs?: number        // default 5000
  client?: MemcachedClient         // pre-constructed for tests
}

interface MemcachedClientOptions {
  host: string
  port: number
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

class MemcachedCacheProvider extends ServiceProvider {
  name = 'cache'
  dependencies = ['config']
}

interface MemcachedCacheConfig {
  driver: 'memcached'
  host: string
  port: number
  prefix?: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}
```

Uses a minimal text-protocol client over `Bun.connect` — no third-party Memcached client dependency. Single TCP connection per `MemcachedCache` instance, serialized request queue.

**Operation mapping:**

| Cache method | Memcached command |
|---|---|
| `get` | `get key\r\n` → parse `VALUE…END` reply |
| `put` | `set key 0 <ttl> <bytes>\r\n<value>\r\n` |
| `has` | `get key\r\n` + non-`END` check |
| `forget` | `delete key\r\n` |
| `flush` | `flush_all\r\n` — **server-wide** |
| `add` | `add key 0 <ttl> <bytes>\r\n<value>\r\n` |
| `increment` / `decrement` | `incr key by\r\n` / `decr key by\r\n` — on `NOT_FOUND`, fall back to `add delta` + retry |
| `lock.acquire` | `add` (atomic put-if-absent) |
| `lock.release` | `get` + compare + `delete` (no CAS-scoped delete in the text protocol — slim race window) |
| `tags(...)` | **throws `CacheDriverError`** — protocol has no native sets or SCAN |

**Limitations:**

- **No tags.** Memcached has no native sets or SCAN; emulating tags via key-list values would require server-wide scans per flush. Out of scope for the driver.
- **`flush()` clears the whole server.** Don't share a Memcached instance with other apps if you call `flush()`.
- **Lock release race.** The `get → compare → delete` sequence has a window where another holder could acquire between the read and the delete. Mitigation: tighter TTLs, or use Redis/Postgres for strict ownership.
- **Counters seed via `add`.** Memcached `incr`/`decr` return `NOT_FOUND` for missing keys. The driver chains `incr → NOT_FOUND → add(delta) → retry incr` so semantics match other drivers ("missing key starts at 0"). Costs an extra round-trip on first increment.

**Errors.** `lock(name, null)` throws `CacheConfigError`. Protocol-level errors (CLIENT_ERROR, SERVER_ERROR) wrap as `CacheDriverError`.
