# Testing broadcast + SSE

`MemoryBroadcaster` is the standard test double — same shape as production, no infrastructure, deterministic ordering when you control the publish/subscribe interleaving.

## Wiring

In test mode, bind `MemoryBroadcaster` (or its provider) the same way you do for single-node dev. Most apps already do this via `defaultTransport`-style env switches; broadcast follows the same pattern.

```ts
// bootstrap/providers.test.ts
import { BroadcastProvider } from '@strav/broadcast'

export default [
  // ...
  new BroadcastProvider(),
]
```

`MemoryBroadcaster` has no config to mock — drop it into the container, inject `Broadcaster`, assert on what comes out.

## Asserting on publishes

The cleanest assertion is "subscribe → run code under test → consume the subscription":

```ts
import { MemoryBroadcaster } from '@strav/broadcast'
import { test, expect } from 'bun:test'

test('order.pay publishes order.paid on the tenant channel', async () => {
  const { broadcaster, orders } = await bootTestApp()
  const sub = broadcaster.subscribe('tenant:acme:orders')

  await orders.pay({ id: 'inv_1', tenantId: 'acme', amountCents: 4900 })

  const { value } = await sub.next()
  expect(value).toEqual({
    id: expect.stringMatching(/^[A-Z0-9]{26}$/),  // ULID
    event: 'order.paid',
    data: { orderId: 'inv_1', amount: 4900 },
  })

  await sub.unsubscribe()
})
```

Subscribe BEFORE running the code under test — if you subscribe after the publish, the event is gone (memory driver fans out to current subscribers; no replay).

## Counting publishes

For tests that care about "did N events fire?", drain the subscription with a timeout:

```ts
async function drain<T>(
  iter: AsyncIterableIterator<T>,
  timeoutMs = 50,
): Promise<T[]> {
  const out: T[] = []
  while (true) {
    const result = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<T>>((r) =>
        setTimeout(() => r({ value: undefined as never, done: true }), timeoutMs),
      ),
    ])
    if (result.done) break
    out.push(result.value)
  }
  return out
}

test('processing a batch publishes one event per row', async () => {
  const { broadcaster, importer } = await bootTestApp()
  const sub = broadcaster.subscribe('imports.progress')

  await importer.run([row1, row2, row3])
  const events = await drain(sub)

  expect(events).toHaveLength(3)
  expect(events.map((e) => e.event)).toEqual([
    'import.row_processed',
    'import.row_processed',
    'import.row_processed',
  ])
  await sub.unsubscribe()
})
```

The timeout closes the iterator after `timeoutMs` of silence — without it, the test would hang waiting for more events that aren't coming. 50ms is plenty in unit tests; bump it if you have real async work between publishes.

## Asserting that nothing was published

The inverse — "this code path must not publish" — is easier:

```ts
test('reverting a pending payment does not publish order.paid', async () => {
  const { broadcaster, orders } = await bootTestApp()
  const sub = broadcaster.subscribe('tenant:acme:orders')

  await orders.revertPending({ id: 'inv_1', tenantId: 'acme' })

  // No event should be waiting. next() with a tiny timeout proves silence.
  const result = await Promise.race([
    sub.next(),
    new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 25)),
  ])
  expect(result).toMatchObject({ done: true })
  await sub.unsubscribe()
})
```

## Testing channel authorization

Authorizer functions are plain functions — test them directly without a Broadcaster:

```ts
import { MemoryBroadcaster } from '@strav/broadcast'

test('tenant orders channel allows the owning user only', async () => {
  const broadcaster = new MemoryBroadcaster()
  const orders = makeOrderRepo({ 'inv_1': { tenantId: 'acme' } })

  broadcaster.authorize('tenant:*:orders.*', async (channel, subject) => {
    const tenant = channel.split(':')[1]
    return (subject as { tenantId: string }).tenantId === tenant
  })

  const allowed = await broadcaster.authorizeFor('tenant:acme:orders.inv_1', {
    id: 'u_1',
    tenantId: 'acme',
  })
  expect(allowed.authorized).toBe(true)

  const denied = await broadcaster.authorizeFor('tenant:acme:orders.inv_1', {
    id: 'u_2',
    tenantId: 'other',
  })
  expect(denied.authorized).toBe(false)
})
```

The default policy (private-/presence- denied, everything else allowed) is part of the base class and gets exercised whether you register custom authorizers or not — there's no need to assert it separately unless your test specifically depends on it.

## Testing SSE handlers

SSE handlers are async generators. You can drive them directly without HTTP:

```ts
test('LiveOrdersController yields events from the broadcaster', async () => {
  const { broadcaster, container } = await bootTestApp()
  const controller = container.make(LiveOrdersController)
  const fakeCtx = {
    request: { params: { tenant: 'acme' }, raw: new Request('http://x/live/orders/acme') },
    auth: { user: { id: 'u_1', tenantId: 'acme' } },
  } as unknown as HttpContext

  const stream = controller.subscribe(fakeCtx)
  void broadcaster.publish('tenant:acme:orders', {
    id: 'evt_1',
    event: 'order.paid',
    data: { orderId: 'inv_1' },
  })

  const { value } = await stream.next()
  expect(value).toMatchObject({
    id: 'evt_1',
    event: 'order.paid',
    data: { orderId: 'inv_1' },
  })

  // Close the stream so the generator's `finally` runs.
  await stream.return(undefined)
})
```

`stream.return(undefined)` triggers your `try/finally` block — same code path as a real client disconnect. Always close the stream at the end of a test so abandoned generators don't leak across tests.

For full-stack SSE tests (HTTP round-trip + the response body), use the HTTP test client to make the request, then read the response body chunk-by-chunk:

```ts
test('GET /live/orders/:tenant streams text/event-stream', async () => {
  const { app, broadcaster } = await bootTestApp()
  const res = await app.fetch(new Request('http://x/live/orders/acme', {
    headers: { authorization: `Bearer ${aliceToken}` },
  }))

  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')

  await broadcaster.publish('tenant:acme:orders', {
    id: 'evt_1',
    event: 'order.paid',
    data: { orderId: 'inv_1' },
  })

  // Read until we see the event, then abort.
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value)
  expect(text).toContain('event: order.paid')
  await reader.cancel()
})
```

`reader.cancel()` closes the response body, which fires the request's `AbortSignal`, which triggers the handler's `finally` cleanup. End the test there — don't try to drain the entire stream, it never ends.

## Disabling heartbeats in tests

The SSE wrapper's default 15s heartbeat is wrong for unit tests — you don't want to wait. Pass `heartbeatMs: 0` when you register the route in test mode, OR build a fresh `Router` per test (the standard pattern) so the option lives at the call site:

```ts
const router = new Router()
router.sse('/test/events', subscribe, { heartbeatMs: 0 })
```

If you're testing the wrapper itself, use the explicit `sseResponse(iterable, { heartbeatMs: 0 })` and assert on the stream.

## Testing PostgresBroadcaster

The driver exposes `pollOnce()` and `sweepOnce()` precisely so unit tests don't have to sleep through poll intervals. Use a stub `db` and drive the loop manually:

```ts
import { PostgresBroadcaster, type PostgresBroadcasterDatabase } from '@strav/broadcast/postgres'

function makeStubDb(): PostgresBroadcasterDatabase & { rows: Row[] } {
  // ... an array-backed query/execute mock; the unit-test suite in
  // packages/broadcast/tests/drivers/postgres_broadcaster.test.ts is
  // the canonical reference.
}

test('publish + poll fans out to the subscriber', async () => {
  const db = makeStubDb()
  const b = new PostgresBroadcaster({ db })
  const sub = b.subscribe('orders')

  await b.publish('orders', { id: 'evt_1', event: 'tick', data: {} })
  await b.pollOnce()                    // drive the cursor without waiting

  const { value } = await sub.next()
  expect(value?.id).toBe('evt_1')
  await sub.unsubscribe()
  await b.close()
})
```

For integration tests against real Postgres, use `bootTestApp({ ... })` with `PostgresBroadcastProvider`, run the migration in the test setup, and let the poll loop run at its natural cadence — but set `pollIntervalMs: 50` in test config so you're not waiting 250ms per assertion.

## Cleaning up between tests

Same two patterns as the mail layer:

1. **Per-test container.** `bootTestApp()` builds a fresh `Broadcaster`. Slowest but fully isolated.
2. **Shared container + `close()` in `afterEach`.** Faster, but every test must close every subscription it opens or the next test sees leaked subscribers.

Pick one. Mixing the two is the source of "this test passes alone but fails in the suite" bugs that take hours to track down.

For PostgresBroadcaster integration tests specifically: `TRUNCATE strav_broadcast_events` in `beforeEach`. The poller will re-prime to id 0 on next subscribe, so tests start from a clean slate.
