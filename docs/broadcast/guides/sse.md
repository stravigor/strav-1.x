# Server-sent events

`router.sse(...)` in `@strav/http` is the standard way to expose a `Broadcaster` channel to the browser. The handler returns an `AsyncIterable<SSEEvent>` — usually an `async function*` — and the router wraps it in a `text/event-stream` response with the correct framing, heartbeats, and abort-aware cleanup.

## End-to-end wiring

```ts
// app/Controllers/live_orders_controller.ts
import { inject, AuthorizationError } from '@strav/kernel'
import { Broadcaster } from '@strav/broadcast'
import type { HttpContext, SSEEvent } from '@strav/http'

@inject()
export class LiveOrdersController {
  constructor(private readonly broadcaster: Broadcaster) {}

  async *subscribe(ctx: HttpContext): AsyncGenerator<SSEEvent> {
    const tenantId = ctx.request.params.tenant
    const channel = `tenant:${tenantId}:orders`

    // Authorize before opening the subscription — denied requests get a
    // clean 403 from the exception handler, not a half-open stream.
    const auth = await this.broadcaster.authorizeFor(channel, ctx.auth?.user)
    if (!auth.authorized) throw new AuthorizationError('Not allowed on this channel.')

    const sub = this.broadcaster.subscribe(channel)
    try {
      for await (const event of sub) {
        yield { id: event.id, event: event.event, data: event.data }
      }
    } finally {
      await sub.unsubscribe()
    }
  }
}
```

```ts
// routes/web.ts
router.sse('/live/orders/:tenant', [LiveOrdersController, 'subscribe'])
  .middleware('auth')
  .name('live.orders')
```

The standard middleware chain (auth, csrf, throttle, etc.) runs before the handler — same shape as any other route.

### Client side

```ts
const es = new EventSource('/live/orders/acme')

es.addEventListener('order.paid', (e) => {
  const { orderId, amount } = JSON.parse(e.data)
  store.markPaid(orderId, amount)
})

es.onerror = () => {
  // Browser auto-reconnects with backoff. No app-level action needed
  // unless you want to surface a "disconnected" UI state.
}
```

`EventSource` is built into every modern browser; no library needed. The browser handles reconnection — with `id:` set on the wire, it'll send `Last-Event-ID` as a request header on reconnect, which you can use to replay missed events (next section).

## `Last-Event-ID` replay

When `EventSource` reconnects, it sends `Last-Event-ID: <last-id-it-saw>` as a request header. Use it to replay events the client missed during the disconnect:

```ts
async *subscribe(ctx: HttpContext): AsyncGenerator<SSEEvent> {
  const channel = `tenant:${ctx.request.params.tenant}:orders`
  const lastEventId = ctx.request.headers.get('last-event-id') ?? undefined

  // Replay first — bounded by how far back you want to look.
  if (lastEventId !== undefined) {
    for (const past of await orders.eventsSince(channel, lastEventId)) {
      yield { id: past.id, event: past.event, data: past.data }
    }
  }

  // Then switch to live.
  const sub = this.broadcaster.subscribe(channel)
  try {
    for await (const event of sub) {
      yield { id: event.id, event: event.event, data: event.data }
    }
  } finally {
    await sub.unsubscribe()
  }
}
```

`@strav/broadcast`'s `Broadcaster.subscribe()` does NOT auto-replay — by design. Subscribers always start from "events from now on", so an SSE handler that wants replay decides what "missed" means for its domain. The Postgres ledger is available via `db.query("SELECT * FROM strav_broadcast_events WHERE event_id > $1 AND channel = $2 ORDER BY id")` if you want a generic implementation — but be careful about retention: events older than `retentionSeconds` (default 5 min) are gone.

For chat-style apps that need durable replay, persist messages to your own table and query that instead of the ledger.

## Heartbeats

The wrapper sends `: heartbeat\n\n` (a comment line, no JS event fires) every 15 seconds by default. Without heartbeats, reverse proxies — nginx, Cloudflare, ALB — silently close "idle" connections after 30-90 seconds and the client thinks the server died.

Tune via `router.sse(path, handler, { heartbeatMs })`:

| Deployment | Recommended interval |
|---|---|
| Direct browser → app (no proxy) | `30000` or disable |
| Behind nginx with default config | `15000` (the default) |
| Behind Cloudflare | `10000` — their idle timeout is tight |
| Set `0` | only when you're sure no intermediary will close the connection |

The comment lines also exercise the `connection alive` path through the entire stack, so a heartbeat that completes the round trip is a meaningful health signal — if heartbeats stop arriving on the client, the connection is dead even if the browser hasn't fired `error` yet.

## Disconnect handling

When the client disconnects:

1. The request's `AbortSignal` fires.
2. The wrapper calls `iterator.return(undefined)` on your generator.
3. Your `finally` block runs — that's where `sub.unsubscribe()` lives.
4. The Broadcaster releases its driver-side resources (memory map entry; Postgres polling slot if no other subscribers).

This is why the `try/finally` pattern is load-bearing — if you forget `sub.unsubscribe()`, abandoned subscriptions accumulate until the process restarts. The driver does best-effort GC via `subscriberCount()`, but the handler is the right place to clean up.

`AsyncGenerator` semantics guarantee the `finally` runs even on early `break` from the consumer side. If you use `for await` over the iterable directly without `try/finally`, the cleanup also runs — but be explicit; it survives refactors better.

## Reverse-proxy gotchas

The wrapper sets these headers automatically, but knowing why helps when something goes wrong:

| Header | What it prevents |
|---|---|
| `content-type: text/event-stream; charset=utf-8` | nginx defaulting to `text/plain` (wrong) |
| `cache-control: no-cache, no-transform` | reverse-proxy gzip; gzip + SSE = no events arrive until the buffer fills |
| `connection: keep-alive` | HTTP/1.1 explicit keep-alive |
| `x-accel-buffering: no` | nginx's `proxy_buffering` (the most common silent failure) |

If events take 30+ seconds to arrive on the client, the culprit is almost always upstream buffering — check nginx `proxy_buffering off;` on the SSE location block. Cloudflare adds another layer: SSE works through their proxy but only on paid plans (their free tier buffers).

HTTP/2 SSE works fine. HTTP/3 SSE works fine. Don't worry about protocol version unless someone insists on it.

## When SSE isn't the right tool

SSE is server → client only. If you need bidirectional realtime — typing indicators, mouse cursors, collaborative editing — use WebSockets (`router.ws(...)`, planned). The dividing line:

- **SSE** — server tells the client about state changes. Order paid, comment posted, new email. Most "notifications" use cases.
- **WebSockets** — client and server both push. Multi-cursor editing, audio/video signalling, anything with a sub-second interactive loop.

SSE wins on simplicity (`new EventSource('/url')` and you're done) and works over HTTP/1.1 with zero proxy configuration beyond what's already documented. Reach for WebSockets when SSE is genuinely insufficient, not before.

## Backpressure

`MemoryBroadcaster` has a per-subscription buffer cap (default 1000 events). If a slow SSE client falls behind — e.g. their network drops while still technically connected — the buffer fills, and the oldest event is dropped on overflow. The `onOverflow` hook lets you wire a counter:

```ts
new BroadcastProvider()
  // or, for explicit construction:
new MemoryBroadcaster({
  maxBufferSize: 1000,
  onOverflow: (channel, dropped) => {
    metrics.increment('broadcast.overflow', { channel })
  },
})
```

If overflow happens frequently for an SSE client, the client is too slow to keep up. The fix is to publish less per event (smaller payloads), aggregate into fewer events, or accept that some clients won't catch every update.
