# Channels

A channel is a routing key — a string that publishers attach to events and subscribers ask for. The `Broadcaster` doesn't impose any structure beyond "it's a string"; conventions are how you keep deployments sane.

## Naming

Three patterns cover almost every real app:

| Shape | Example | When |
|---|---|---|
| `<resource>.<id>` | `orders.42` | Per-record live updates — order detail page, single chat thread. |
| `<aggregate>` | `news`, `system.health` | App-wide events. Use sparingly: every connected client subscribes, so the fan-out cost scales with users. |
| `<tenant>:<resource>.<id>` | `acme:orders.42` | Multi-tenant apps. The tenant id in the channel name guarantees one tenant's events never leak into another tenant's subscription. |

Keep channel names short — they ride on every published event and on every SSE handshake. Avoid colons or wildcards inside the resource portion since the authorizer registry uses `*` as the trailing wildcard.

## The `private-` and `presence-` prefixes

Two prefixes are reserved with default-deny semantics:

- **`private-<channel>`** — denied unless an authorizer matches. Use for any channel that carries data not all users may see (order status, DM threads, audit trails).
- **`presence-<channel>`** — same default-deny, plus the authorizer's `presence` metadata is surfaced to the SSE handler so it can announce who's connected.

Channels without one of these prefixes are public — anyone who can hit the SSE endpoint can subscribe. Most production endpoints should sit behind the `private-` or `presence-` model and use the unprefixed form only for genuinely-public streams (anonymized homepage tickers, status pages).

The defaults live on the `Broadcaster` base class, not on individual drivers, so swapping `MemoryBroadcaster` for `PostgresBroadcaster` (or any custom driver) keeps the same auth semantics.

## Authorization

`broadcaster.authorize(pattern, fn)` registers a check. Patterns are exact names or trailing-wildcard prefixes; longer prefixes win over shorter ones; exact matches always beat wildcards.

```ts
// app/bootstrap/broadcast.ts
import { Broadcaster } from '@strav/broadcast'

export function registerChannels(broadcaster: Broadcaster, orders: OrderRepository): void {
  // Exact channel — only the order's owning user.
  broadcaster.authorize('private-orders.42', async (channel, subject) => {
    const userId = (subject as { id: string }).id
    return await orders.belongsTo(channel.split('.')[1]!, userId)
  })

  // Wildcard — every order channel uses the same rule.
  broadcaster.authorize('private-orders.*', async (channel, subject) => {
    const orderId = channel.slice('private-orders.'.length)
    return await orders.belongsTo(orderId, (subject as { id: string }).id)
  })

  // Presence channel — the function returns metadata about the subject.
  broadcaster.authorize('presence-room-*', async (channel, subject) => {
    const room = channel.slice('presence-room-'.length)
    const user = subject as { id: string; name: string }
    if (!(await rooms.canJoin(room, user.id))) return false
    return { authorized: true, presence: { id: user.id, name: user.name } }
  })
}
```

Three things to notice:

- **Register at boot.** Walk the registry once during provider boot, not on every request. The functions close over your repositories, so DI works as you'd expect.
- **The authorizer is a plain function.** It can be async, it can hit a database, it can call into the auth subsystem — but every SSE connection runs it on subscribe, so keep it fast or cache hot paths.
- **Boolean is sugar.** Returning `true` is equivalent to `{ authorized: true }`; returning `false` is `{ authorized: false }`. Presence channels need the structured form so subscribers receive the `presence` metadata.

## Multi-tenant channel design

The reliable pattern is tenant-prefixing every channel:

```ts
const channel = `tenant:${tenantId}:orders.${orderId}`
await broadcaster.publish(channel, event)
```

```ts
broadcaster.authorize('tenant:*:orders.*', async (channel, subject) => {
  const [, tenant] = channel.split(':')
  const user = subject as { id: string; tenantId: string }
  return user.tenantId === tenant && await orders.belongsTo(channel, user.id)
})
```

Why not use the `private-` prefix for tenant isolation? Two reasons:

1. **Explicit beats implicit.** A `tenant:acme:` channel makes the boundary visible everywhere — logs, debug dashboards, `subscriberCount()`. A `private-` name only tells you "needs auth", not which tenant it belongs to.
2. **Avoids cross-tenant subscription leaks.** If an attacker tricks an authorizer into returning `true` for `private-orders.42`, you've leaked one order. If the same bug hits `tenant:acme:orders.42`, the attacker still needs to know the tenant id and would only leak within the wrong tenant — limited blast radius.

You can combine the two: `private-tenant:acme:orders.42` is a perfectly fine name that gets both default-deny AND tenant prefixing. The wildcard registration adapts: `'private-tenant:*:orders.*'`.

## Channel discovery + cleanup

`broadcaster.subscriberCount(channel)` (on `MemoryBroadcaster` — and on `PostgresBroadcaster` via its embedded memory layer) tells you how many local subscribers a channel has. Useful for:

- **Health checks** — alert if a critical channel's subscriber count drops to zero unexpectedly.
- **Lazy publishing** — skip the publish cost when nobody's listening, e.g. `if (broadcaster.subscriberCount(channel) > 0) { ... }`. On Postgres this only sees local subscribers, so it's a hint, not a guarantee.

There's no global subscriber registry on the Postgres backplane — that would require an extra table + heartbeating, which adds complexity for little benefit. If you need cross-node subscription telemetry, publish a "subscriber heartbeat" event from each node and aggregate downstream.

## What channels should NOT carry

The `BroadcastEvent.data` field round-trips through JSON, so:

- **No `Date`** — it round-trips as a string. Serialize explicitly with `.toISOString()` if you need wall-clock semantics on the receiver.
- **No `Buffer` / `Uint8Array`** — base64-encode large payloads, or push a reference (an object-storage URL) and let the receiver fetch.
- **No PII you don't need to send.** Channels are convenient — there's a temptation to attach "the whole user object" to every event. Resist it: send the minimum the receiver actually needs.

For high-volume streams (e.g. typing indicators in a chat), prefer publishing notification events (`{ event: 'typing.start', data: { userId } }`) over object payloads — they're cheaper to serialise and the receiver can reconstruct UI state from the verb.
