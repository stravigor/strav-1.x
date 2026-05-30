# Postgres backplane

`MemoryBroadcaster` is one process. The moment your app runs more than one node — two app servers, a worker fleet, a blue/green deploy — events published on one node don't reach subscribers on another. `PostgresBroadcaster` solves that with a polled ledger table.

## When to switch

The honest answer is "before you need to, but not earlier than you need to":

- **Stay on memory** for: solo deployments, dev environments, single-node PaaS apps (Fly, Railway with a single instance), any setup where you control horizontal scaling and chose not to.
- **Move to Postgres** the day you spin up a second instance — even temporarily for a deploy. Cross-instance event drop is hard to diagnose later because the symptom is "sometimes the UI doesn't update" and it tracks to which node served the request.

Migration is a provider swap and a one-shot DDL apply. No code in your controllers / notifications / SSE handlers changes — they keep injecting `Broadcaster`.

## Setup

Two files change.

```ts
// bootstrap/providers.ts
import {
  PostgresBroadcastProvider,
  broadcastEventSchema,
} from '@strav/broadcast/postgres'
import { SchemaRegistryProvider } from '@strav/database'

export default [
  // ... ConfigProvider, LoggerProvider, DatabaseProvider, etc.
  new SchemaRegistryProvider({
    schemas: [
      broadcastEventSchema,        // register so generateMigration picks it up
      // ... your app's schemas
    ],
  }),
  new PostgresBroadcastProvider(), // INSTEAD OF BroadcastProvider
]
```

```ts
// migrations/<timestamp>_create_broadcast_ledger.ts
import type { Migration } from '@strav/database'
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

Run the migration, redeploy. Every node now publishes to the same ledger and reads from the same polling cursor.

## How it actually works

One INSERT per `publish()` — no batching, no async write queue. The ledger is the source of truth.

Each process runs ONE polling loop, regardless of subscription count. The loop:

1. Sleeps for `pollIntervalMs` (default 250ms).
2. Runs `SELECT id, channel, event_name, event_id, data FROM strav_broadcast_events WHERE id > $lastId ORDER BY id LIMIT 1000`.
3. For each row, hands the event to a per-process `MemoryBroadcaster` that fans out to local subscribers.
4. Updates `$lastId` to the highest row id seen.

On boot, `$lastId` is primed to `SELECT MAX(id)` — subscribers never see events published before they subscribed. The loop starts lazily on first `subscribe()` and stops at `close()`; pure publishers (e.g. queue workers) never spin a poller.

A retention sweep (`DELETE FROM strav_broadcast_events WHERE created_at < now() - interval`) runs every `cleanupIntervalMs` (default 30s) and drops rows older than `retentionSeconds` (default 300s). Keeps the table bounded.

## Latency

The polling interval is your latency floor — events are visible to subscribers `~0.5 × pollIntervalMs` after the INSERT commits, on average.

| `pollIntervalMs` | p50 latency | Comment |
|---|---|---|
| `100` | ~50 ms | Snappy. Postgres CPU still negligible at typical app QPS. |
| `250` (default) | ~125 ms | The right default. Indistinguishable from "live" for most UIs. |
| `500` | ~250 ms | Acceptable for non-interactive notifications. |
| `1000` | ~500 ms | Noticeable in side-by-side UI tests. Use only if Postgres CPU is a constraint. |

If you need sub-50ms cross-node delivery, Postgres isn't the right backplane — write a Redis driver against the `Broadcaster` interface. For the 95% of apps that don't need it, 250ms is fine.

## Retention

`retentionSeconds` (default 300) controls how long events stay in the table. The right value depends on what you want to support:

- **300s** — covers SSE clients reconnecting after a transient network blip. Default.
- **3600s** — supports `Last-Event-ID` replay across longer disconnects (laptop closed for an hour, etc.). Costs more table size.
- **86400s** — gives you a 24h audit log of fanned-out events. Worth considering for compliance / debug; expect substantially more storage.

Retention is NOT a replacement for application-level history. If your app needs durable event log (chat messages, audit trail), persist to your own table — the broadcast ledger is "the last N minutes of fan-out", not "the history of everything that happened".

## Config

```ts
// config/broadcast.ts
import type { PostgresBroadcastConfig } from '@strav/broadcast/postgres'

export default {
  driver: 'postgres',
  pollIntervalMs: 250,
  retentionSeconds: 300,
  cleanupIntervalMs: 30_000,
  maxBufferSize: 1000,
} satisfies PostgresBroadcastConfig
```

All fields are optional — the defaults shown above are what the driver uses when you don't override them. The `db` field isn't in config because the provider resolves `Database` from the container.

## Operations

### Watching the ledger

The table is plain Postgres — query it directly during an incident:

```sql
-- Recent traffic by channel
SELECT channel, count(*) AS events, max(created_at) AS last_seen
FROM strav_broadcast_events
WHERE created_at > now() - interval '5 minutes'
GROUP BY channel
ORDER BY events DESC;

-- Has the poll cursor stalled? (Compare to subscriber log timestamps.)
SELECT max(id) FROM strav_broadcast_events;

-- Is retention working?
SELECT min(created_at), max(created_at), count(*) FROM strav_broadcast_events;
```

The `event_id` column carries whatever you set when calling `publish()` — ULIDs are recommended because they sort naturally. The `id` column is a `bigserial` and exists only as the polling cursor; don't expose it to clients.

### Catching up after a backlog

If publishers ran while pollers were down (a long deploy, a Postgres failover), the cursor catches up automatically — `WHERE id > $lastId ORDER BY id LIMIT 1000` runs as fast as the LIMIT allows. For a backlog of N events, expect `N / 1000 × pollIntervalMs` to fully drain.

If you need to deliberately skip a backlog (e.g. events became stale during a long outage), the operationally-clean move is to `TRUNCATE strav_broadcast_events` before restarting subscribers. The pollers will re-prime to `MAX(id) = 0` and resume from "now".

### Index health

`applyBroadcastMigration` creates two indexes:

- The PK on `id` — used by every poll query.
- `created_at` — used by the retention sweep.

Both are tiny relative to the typical app's other indexes. The table itself stays bounded by retention. No manual maintenance needed in normal operation.

If `VACUUM` falls behind on this table specifically (you'd see it as growing table size despite the sweep deleting rows), tune the autovacuum threshold for `strav_broadcast_events`:

```sql
ALTER TABLE strav_broadcast_events SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 1000
);
```

This is rare — only seen on apps publishing millions of events per minute through this ledger.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Events publish but subscribers don't see them | The Postgres `Database` binding resolved a different pool than the publisher uses | Verify both code paths share the same `Database` instance — the container token should resolve to the same singleton. |
| Latency higher than `pollIntervalMs` would predict | DB round-trip + index scan slower than expected; large backlog draining | Check `pg_stat_activity` for slow queries; lower batch limit if memory-bound. |
| Table grows unbounded | Retention sweep failing silently | Check Postgres logs for permission errors on DELETE; verify the connection role has DELETE on the table. |
| Pollers stop fetching | A Postgres failover or connection-pool drain | The driver's polling loop swallows errors silently to survive transient blips; for chronic issues, the next `publish()` from any node will keep the table alive but subscribers won't get events until the loop's next tick succeeds. Wire DB-driver logging if you need visibility. |

## When NOT Postgres

The Postgres backplane is the right answer for almost every multi-node Strav app. Reach for alternatives when:

- **You need <50ms cross-node delivery.** Polling can't beat the Redis pub/sub or NATS round-trip. Write a Redis driver — the contract is two methods.
- **Your Postgres is already saturated.** A few hundred publishes/second is nothing for Postgres; a few thousand can stress a shared instance. Move the broadcast ledger to its own Postgres before reaching for Redis.
- **You're horizontally scaling subscribers, not publishers.** A large SSE fleet (10k+ concurrent clients per process) doesn't hit the backplane harder — the polling is per-process — but the `MemoryBroadcaster` fan-out is per-subscriber. Profile before assuming the bottleneck is here.
