# @strav/broadcast

In-process and multi-node pub/sub for Strav 1.0. The package exposes the `Broadcaster` abstraction every consumer injects, plus two concrete drivers — `MemoryBroadcaster` (single-node) and `PostgresBroadcaster` (multi-node via a polled ledger table). Apps swap providers in `bootstrap/providers.ts`; the rest of the codebase stays driver-agnostic.

> **Status: 1.0.0-alpha.** Memory + Postgres drivers shipped. Pairs with `router.sse()` in `@strav/http` and `@strav/notification/broadcast` to fan-out notifications to live SSE clients. No Redis backplane yet (no consumers asking for it); apps that need one write a small driver against the `Broadcaster` contract.

## What's here

| Export | Notes |
|---|---|
| `Broadcaster` | Abstract base + container token. Subclasses must implement `publish` and `subscribe`. The base provides `authorize` / `authorizeFor` and a no-op `close` |
| `BroadcastEvent` / `BroadcastSubscription` | Wire shape (`{ id, event, data }`) + the subscriber's `AsyncIterableIterator` handle |
| `ChannelAuthorizer` / `ChannelAuthorizerRegistry` | Per-channel auth — exact names + trailing-wildcard patterns. Longest-prefix wins |
| `BroadcastError` + `BroadcastConfigError` / `BroadcastPublishError` / `BroadcastUnauthorizedError` | Typed error hierarchy, same shape as `@strav/notification` |
| `BroadcastProvider` | Wires `MemoryBroadcaster` under the `Broadcaster` token. Default for single-node deployments |
| `MemoryBroadcaster` | In-process fan-out. Bounded per-subscription buffer (default 1000 events), overflow hook for telemetry |
| `PostgresBroadcaster` (subpath) | Polled `strav_broadcast_events` ledger. One poller per process, lazy-started on first `subscribe()`, lazy-stopped at close |
| `PostgresBroadcastProvider` (subpath) | Wires `PostgresBroadcaster` under the same `Broadcaster` token |
| `applyBroadcastMigration` (subpath) | Emits DDL for the ledger + the retention sweep's `created_at` index |
| `broadcastEventSchema` (subpath) | The `@strav/database` schema entry — register with your `SchemaRegistry` so `generateMigration` picks it up |

## Install

```bash
bun add @strav/broadcast
# Postgres backplane only: also need @strav/database
bun add @strav/database
```

## Minimal example — single-node dev

`config/broadcast.ts` is optional for the memory driver; defaults are sane.

```ts
// bootstrap/providers.ts
import {
  ConfigProvider,
  LoggerProvider,
} from '@strav/kernel'
import { BroadcastProvider } from '@strav/broadcast'

export default [
  new ConfigProvider({ /* ... */ }),
  new LoggerProvider(),
  new BroadcastProvider(),
]
```

```ts
@inject()
class OrdersController {
  constructor(private readonly broadcaster: Broadcaster) {}

  async pay(): Promise<void> {
    await this.broadcaster.publish('orders.42', {
      id: ulid(),
      event: 'order.paid',
      data: { amount: 4900 },
    })
  }
}
```

Subscribers iterate. Most apps consume through `router.sse(...)` in `@strav/http` or through `BroadcastNotificationDriver`, but direct iteration works too:

```ts
const sub = broadcaster.subscribe('orders.42')
for await (const event of sub) {
  console.log(event)
  if (event.event === 'order.shipped') break       // return() runs on break
}
```

## Multi-node — Postgres backplane

Two changes vs. the dev wiring:

1. Register `PostgresBroadcastProvider` instead of `BroadcastProvider`. Both bind under the same `Broadcaster` token.
2. Register `broadcastEventSchema` with your `SchemaRegistry` and run `applyBroadcastMigration` in a migration's `up`.

```ts
import { PostgresBroadcastProvider, broadcastEventSchema } from '@strav/broadcast/postgres'

// bootstrap/providers.ts
export default [
  new ConfigProvider({ /* ... */ }),
  new LoggerProvider(),
  new DatabaseProvider(),
  new SchemaRegistryProvider({ schemas: [broadcastEventSchema /* + your app schemas */] }),
  new PostgresBroadcastProvider(),
]
```

```ts
// migrations/20260601000000_create_broadcast_ledger.ts
import { applyBroadcastMigration } from '@strav/broadcast/postgres'

export const migration: Migration = {
  name: '20260601000000_create_broadcast_ledger',
  async up(db) {
    await applyBroadcastMigration(db, { registry })
  },
  async down(db) {
    await db.execute('DROP TABLE IF EXISTS "strav_broadcast_events"')
  },
}
```

### How the Postgres driver works

- `publish(channel, event)` INSERTs one row.
- One poller per process runs `SELECT * FROM strav_broadcast_events WHERE id > $lastId ORDER BY id` every `pollIntervalMs` (default 250ms).
- New rows are fanned out to local subscribers via an embedded `MemoryBroadcaster`.
- Subscribers always start from "events published from now on" — no historical replay on subscribe.
- A retention sweep runs every `cleanupIntervalMs` (default 30s) and deletes rows older than `retentionSeconds` (default 300s). Tune retention up if you want to bound replay-on-reconnect; keep it low otherwise.

The polling interval is the latency floor. 250ms is the default because it keeps DB CPU negligible and end-to-end well under 500ms; production deployments needing tighter SLOs can drop to 100ms without trouble.

### `config/broadcast.ts` knobs

```ts
import type { PostgresBroadcastConfig } from '@strav/broadcast/postgres'

export default {
  driver: 'postgres',
  pollIntervalMs: 250,              // latency floor
  retentionSeconds: 300,            // ledger TTL
  cleanupIntervalMs: 30_000,        // how often the sweep runs
  maxBufferSize: 1000,              // per-subscription buffer cap
} satisfies PostgresBroadcastConfig
```

For the memory driver, the `MemoryBroadcastConfig` shape mirrors `MemoryBroadcasterOptions` (`{ driver: 'memory', maxBufferSize?, onOverflow? }`).

## Channel authorization

`broadcaster.authorize(pattern, fn)` registers a per-channel check. Patterns are either exact names or trailing-wildcard prefixes (`'private-orders.*'`). Longest prefix wins, exact-match always beats wildcards.

```ts
broadcaster.authorize('private-orders.*', async (channel, subject) => {
  const userId = (subject as { id: string }).id
  const tenantId = channel.split('.')[1]
  return await orders.tenantBelongsToUser(tenantId, userId)
})

broadcaster.authorize('presence-room-*', (channel, subject) => ({
  authorized: true,
  presence: { id: (subject as { id: string }).id, name: subject.name },
}))
```

Defaults when nothing matches:

- `private-*` and `presence-*` → **denied**. Authorize explicitly to grant.
- everything else → **allowed**.

The SSE handler and the broadcast notification driver call `broadcaster.authorizeFor(channel, subject)` before opening a subscription; subjects are typically the request's authenticated user, but anything serialisable works.

## Guides

- [`guides/channels.md`](./guides/channels.md) — naming conventions, the `private-`/`presence-` prefix model, authorization patterns, multi-tenant channel design.
- [`guides/sse.md`](./guides/sse.md) — end-to-end `router.sse` wiring, `Last-Event-ID` replay, reconnect handling, reverse-proxy gotchas, backpressure.
- [`guides/postgres_backplane.md`](./guides/postgres_backplane.md) — when to switch from memory, tuning `pollIntervalMs` + retention, operations + failure modes.
- [`guides/testing.md`](./guides/testing.md) — `MemoryBroadcaster` patterns, asserting on publishes, testing SSE handlers + the Postgres driver without spinning up a DB.

## Pairs with

- **[`router.sse()`](../http/api.md) in `@strav/http`** — wraps an `AsyncIterable<SSEEvent>` into a text/event-stream response. A subscription to a Broadcaster channel is the most common iterable to wire through it.
- **[`@strav/notification/broadcast`](../notification/api.md)** — `BroadcastNotificationDriver` reads `toBroadcast(notifiable)` and publishes to the configured `Broadcaster`. Live UI updates and traditional notifications stay one fan-out.
