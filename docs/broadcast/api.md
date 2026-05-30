# `@strav/broadcast` API

Public exports + semantics. Pairs with the [README](./README.md) overview.

## Root barrel — `@strav/broadcast`

### `class Broadcaster`

```ts
class Broadcaster {
  publish(channel: string, event: BroadcastEvent): Promise<void>      // override
  subscribe(channel: string): BroadcastSubscription                    // override
  authorize(pattern: string, fn: ChannelAuthorizer): void
  authorizeFor(channel: string, subject: unknown): Promise<ChannelAuthorizationResult>
  close(): Promise<void>                                                // default no-op
}
```

Container token + abstract base. Concrete drivers override `publish` and `subscribe`; the defaults throw to surface forgotten overrides during development.

**Default authorization policy** when no authorizer matches:
- `private-*` and `presence-*` → `{ authorized: false }`.
- everything else → `{ authorized: true }`.

### `BroadcastEvent` / `BroadcastSubscription`

```ts
interface BroadcastEvent {
  event: string         // verb tag (e.g. 'order.paid')
  data: unknown         // JSON-serialisable
  id: string            // publisher-assigned identifier (ULIDs recommended)
}

interface BroadcastSubscription extends AsyncIterableIterator<BroadcastEvent> {
  unsubscribe(): Promise<void>
}
```

Breaking out of a `for await` loop calls the iterator's `return()`, which the drivers wire to `unsubscribe()`. No explicit cleanup needed in the common case.

### `ChannelAuthorizer` / `ChannelAuthorizerRegistry`

```ts
type ChannelAuthorizer = (
  channel: string,
  subject: unknown,
) => boolean | ChannelAuthorizationResult | Promise<boolean | ChannelAuthorizationResult>

interface ChannelAuthorizationResult {
  authorized: boolean
  presence?: Record<string, unknown>   // surfaces on presence channels
}

class ChannelAuthorizerRegistry {
  register(pattern: string, fn: ChannelAuthorizer): void
  match(channel: string): ChannelAuthorizer | undefined
  clear(): void
}
```

Patterns are either exact names or trailing-wildcard prefixes (`'private-orders.*'`). Longer prefixes win over shorter ones; exact matches always beat wildcards. Returning a boolean is sugar for `{ authorized: bool }` — presence channels return the structured form so subscribers receive metadata about who's connected.

### `BroadcastError`

Subclasses (all extend `StravError`):

- `BroadcastError` — `code: 'broadcast.error'`, base.
- `BroadcastConfigError` — `code: 'broadcast.config'`, `status: 500`. Provider boot.
- `BroadcastPublishError` — `code: 'broadcast.publish'`, `status: 502`. Driver-side publish failure (serialisation, DB INSERT, etc.).
- `BroadcastUnauthorizedError` — `code: 'broadcast.unauthorized'`, `status: 403`. Callers that gate on `authorizeFor()` throw this when denied.

### `MemoryBroadcaster`

```ts
class MemoryBroadcaster extends Broadcaster {
  constructor(options?: MemoryBroadcasterOptions)
  subscriberCount(channel: string): number   // diagnostics
}

interface MemoryBroadcasterOptions {
  maxBufferSize?: number                                          // default 1000
  onOverflow?: (channel: string, droppedEvent: BroadcastEvent) => void
}
```

In-process pub/sub. Per-subscription bounded buffer; on overflow the oldest event is dropped and `onOverflow` is invoked. `close()` ends every pending iterator.

### `BroadcastProvider`

```ts
class BroadcastProvider extends ServiceProvider {
  name = 'broadcast'
  dependencies = ['config']
}

interface MemoryBroadcastConfig extends MemoryBroadcasterOptions {
  driver: 'memory'
}
```

Binds `MemoryBroadcaster` under the `Broadcaster` token. Reads `config.broadcast` for the optional overrides — apps that don't configure anything get the defaults.

## `@strav/broadcast/memory`

Re-exports `MemoryBroadcaster` + `MemoryBroadcasterOptions` for explicit construction (when an app wires its own provider). The root barrel already exports the same symbols; the subpath exists for consistency with the other driver subpaths.

## `@strav/broadcast/postgres`

```ts
class PostgresBroadcaster extends Broadcaster {
  constructor(options: PostgresBroadcasterOptions)
  pollOnce(): Promise<void>          // exposed for tests
  sweepOnce(): Promise<number>       // returns deleted-row count
}

interface PostgresBroadcasterDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  execute(sql: string, params?: readonly unknown[]): Promise<number>
}

interface PostgresBroadcasterOptions {
  db: PostgresBroadcasterDatabase
  pollIntervalMs?: number            // default 250
  retentionSeconds?: number          // default 300
  cleanupIntervalMs?: number         // default 30_000
  maxBufferSize?: number             // forwarded to internal MemoryBroadcaster
  onOverflow?: (channel: string, droppedEvent: BroadcastEvent) => void
}

class PostgresBroadcastProvider extends ServiceProvider {
  name = 'broadcast'
  dependencies = ['config', 'database']
}

interface PostgresBroadcastConfig extends Omit<PostgresBroadcasterOptions, 'db'> {
  driver: 'postgres'
}

const broadcastEventSchema: Schema       // `strav_broadcast_events` (Archetype.Event)

function applyBroadcastMigration(
  db: DatabaseExecutor,
  options: { registry: SchemaRegistry },
): Promise<void>
```

**Wire shape.** `publish` is one INSERT per call. The poller starts on first `subscribe()`, polls every `pollIntervalMs`, and emits each new row to local subscribers via an internal `MemoryBroadcaster`. On startup the cursor is primed to `SELECT MAX(id)` so existing rows are not replayed. The retention sweep runs every `cleanupIntervalMs` and deletes rows older than `retentionSeconds`.

**No replay on subscribe.** Subscribers only receive events published after they subscribe. Apps that need replay (e.g. SSE `Last-Event-ID` recovery) query the table directly and emit historical events into their handler before iterating the live subscription.

**Errors.** `publish` wraps both serialisation failures and DB-side INSERT errors as `BroadcastPublishError` with `context.channel` + `context.event` + the original error preserved as `cause`. The polling loop swallows errors silently — a transient DB blip shouldn't tear the broadcaster down, and apps wire visibility through the database driver's own logging.

## `@strav/broadcast/redis`

```ts
class RedisBroadcaster extends Broadcaster {
  constructor(options: RedisBroadcasterOptions)
  upstreamSubscribed(channel: string): boolean    // diagnostics for tests
}

interface RedisBroadcasterClient {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<number>
  unsubscribe(channel: string): Promise<void>
  close(): void
}

interface RedisBroadcasterOptions {
  url?: string                       // required unless pub + sub are injected
  pub?: RedisBroadcasterClient       // custom publisher client (tests)
  sub?: RedisBroadcasterClient       // custom subscriber client (tests)
  maxBufferSize?: number             // forwarded to internal MemoryBroadcaster
  onOverflow?: (channel: string, droppedEvent: BroadcastEvent) => void
}

class RedisBroadcastProvider extends ServiceProvider {
  name = 'broadcast'
  dependencies = ['config']
}

interface RedisBroadcastConfig extends Omit<RedisBroadcasterOptions, 'pub' | 'sub'> {
  driver: 'redis'
}
```

**Wire shape.** Two `Bun.RedisClient` instances under the hood — one for `PUBLISH`, one for `SUBSCRIBE`. Bun's client enters a sticky pub/sub mode after `subscribe(...)` that blocks most other commands until `unsubscribe()`; splitting publish + subscribe avoids the lock. Multiple in-process subscribers to the same channel share one upstream `SUBSCRIBE`; the upstream `UNSUBSCRIBE` fires when the last local subscriber drops.

**No replay on subscribe.** Same contract as the Postgres driver — subscribers only receive events published after their `subscribe()`. Apps that need replay layer the Postgres driver alongside, or write a stream-backed custom driver.

**Errors.** `publish` wraps both `JSON.stringify` failures and `PUBLISH` errors as `BroadcastPublishError`. The subscribe listener silently drops non-JSON payloads — apps sharing the Redis instance with other publishers shouldn't crash the broadcaster.
