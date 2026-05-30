# @strav/broadcast

In-process and multi-node pub/sub for Strav 1.0. Powers SSE endpoints (`router.sse(...)` in `@strav/http`) and the broadcast notification channel (`@strav/notification/broadcast`). Apps inject the abstract `Broadcaster` token; the provider in the container picks the concrete driver — `MemoryBroadcaster` for single-node dev, `PostgresBroadcaster` for multi-node deployments.

```ts
import { Broadcaster } from '@strav/broadcast'

@inject()
class OrdersController {
  constructor(private readonly broadcaster: Broadcaster) {}

  async pay(req: Request): Promise<Response> {
    const order = await this.orders.markPaid(req)
    await this.broadcaster.publish(`private-orders.${order.tenantId}`, {
      id: order.eventId,
      event: 'order.paid',
      data: { orderId: order.id, amount: order.amountCents },
    })
    return new Response(null, { status: 204 })
  }
}
```

Canonical docs live in [`docs/broadcast/README.md`](../../docs/broadcast/README.md).

## What ships

| Driver | Subpath | Notes |
|---|---|---|
| Memory | `@strav/broadcast` (root) + `@strav/broadcast/memory` | In-process pub/sub. Single-node only. Bounded per-subscription buffer with overflow hooks. |
| Postgres | `@strav/broadcast/postgres` | Polling-ledger backplane (`strav_broadcast_events` table). Multi-node. ~250ms p50 latency at default polling interval. |

Per-channel authorization is built into the base class — register exact names or trailing-wildcard patterns (`'private-orders.*'`) via `broadcaster.authorize(pattern, fn)`. Channels with the `private-` or `presence-` prefix are denied by default unless an authorizer says yes.
