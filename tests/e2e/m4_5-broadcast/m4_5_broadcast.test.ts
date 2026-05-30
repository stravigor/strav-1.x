/**
 * M4.5 end-to-end smoke — proves `@strav/broadcast` + the broadcast
 * notification channel + the SSE response runtime against real
 * Postgres.
 *
 * The wire under test:
 *
 *   notifications.send(alice, new OrderPaid(...))
 *     → BaseNotification.via(notifiable) → ['broadcast']
 *     → BroadcastNotificationDriver.send
 *       → Broadcaster.publish(channel, event)
 *         → PostgresBroadcaster → INSERT into strav_broadcast_events
 *           ─── (real Postgres round-trip; cross-process safe) ───
 *           → poller picks up the row on the next tick
 *             → embedded MemoryBroadcaster fans out to local subscribers
 *               → AsyncIterable<BroadcastEvent>           ← assertion target
 *               → sseResponse(iterable) → text/event-stream chunks   ← assertion target
 *
 * Self-skips when no Postgres is available — matches the integration
 * suites' contract.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BroadcastEvent, Broadcaster } from '@strav/broadcast'
import {
  applyBroadcastMigration,
  type PostgresBroadcaster,
  PostgresBroadcastProvider,
} from '@strav/broadcast/postgres'
import {
  BaseNotification,
  type Notifiable,
  NotificationManager,
  NotificationProvider,
} from '@strav/notification'
import { BroadcastNotificationProvider } from '@strav/notification/broadcast'
import { type BootTestAppResult, bootTestApp, isPostgresAvailable } from '@strav/testing'

const PG_AVAILABLE = await isPostgresAvailable()

// ─── Notification fixture ───────────────────────────────────────────────

class OrderPaid extends BaseNotification {
  constructor(private readonly payload: { orderId: string; amount: number; tenantId: string }) {
    super()
  }
  override via(_n: Notifiable): readonly string[] {
    return ['broadcast']
  }
  toBroadcast(_n: Notifiable) {
    return {
      channel: `tenant:${this.payload.tenantId}:orders`,
      event: 'order.paid',
      data: { orderId: this.payload.orderId, amount: this.payload.amount },
    }
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('M4.5 e2e: broadcast + SSE through Postgres', () => {
  let booted: BootTestAppResult
  let broadcaster: PostgresBroadcaster

  beforeAll(async () => {
    booted = await bootTestApp({
      config: {
        broadcast: {
          driver: 'postgres',
          // Aggressive poll so assertions don't sleep through 250ms.
          pollIntervalMs: 25,
        },
        notification: {
          channels: {
            broadcast: { driver: 'broadcast' },
          },
        },
      },
      // applyBroadcastMigration already calls emitCreateTable internally —
      // passing `schemas:` here would re-emit the same CREATE TABLE and
      // conflict. The SchemaRegistry needs the schema for repository
      // introspection but PostgresBroadcaster reads the table name off
      // the schema object directly, so registration isn't required here.
      migrations: [(db, registry) => applyBroadcastMigration(db, { registry })],
      providers: [
        new PostgresBroadcastProvider(),
        new NotificationProvider(),
        new BroadcastNotificationProvider(),
      ],
    })
    broadcaster = booted.app.resolve(Broadcaster) as PostgresBroadcaster
  })

  afterAll(() => booted.dispose())

  test('migration created the strav_broadcast_events table + retention index', async () => {
    const tables = await booted.setupDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'strav_broadcast_events'`,
    )
    expect(tables.length).toBe(1)

    const indexes = await booted.setupDb.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'strav_broadcast_events'`,
    )
    expect(indexes.map((i) => i.indexname)).toContain('idx_strav_broadcast_events_created_at')
  })

  test('publish round-trips through the ledger to a subscriber', async () => {
    const sub = broadcaster.subscribe('tenant:acme:orders')

    await broadcaster.publish('tenant:acme:orders', {
      id: 'evt_direct_1',
      event: 'tick',
      data: { hello: 'world' },
    })
    // Wait for the poller tick to pick up the row. With pollIntervalMs=25,
    // 100ms is plenty of slack.
    const event = await racedNext(sub, 250)

    expect(event).toEqual({
      id: 'evt_direct_1',
      event: 'tick',
      data: { hello: 'world' },
    })
    await sub.unsubscribe()
  })

  test('NotificationManager.send fans through BroadcastNotificationDriver onto the ledger', async () => {
    const notifications = booted.app.resolve(NotificationManager)
    const sub = broadcaster.subscribe('tenant:acme:orders')

    const result = await notifications.send(
      { id: 'u_alice', notifiableType: 'User' },
      new OrderPaid({ orderId: 'inv_42', amount: 4900, tenantId: 'acme' }),
    )

    // Notification reported delivered.
    expect(result.deliveries).toHaveLength(1)
    expect(result.deliveries[0]).toMatchObject({ channel: 'broadcast', delivered: true })

    // Subscriber sees the published event with the dispatch's ULID as the event id.
    const event = await racedNext(sub, 250)
    expect(event?.id).toBe(result.id)
    expect(event?.event).toBe('order.paid')
    expect(event?.data).toEqual({ orderId: 'inv_42', amount: 4900 })

    // Ledger has the row.
    const rows = await booted.setupDb.query<{ channel: string; event_name: string }>(
      `SELECT channel, event_name FROM strav_broadcast_events WHERE event_id = $1`,
      [result.id],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]).toEqual({ channel: 'tenant:acme:orders', event_name: 'order.paid' })

    await sub.unsubscribe()
  })

  test('subscriber only sees events published after subscribe (no historical replay)', async () => {
    // Publish first — before any subscriber exists.
    await broadcaster.publish('tenant:acme:archive', {
      id: 'evt_historical_1',
      event: 'tick',
      data: { phase: 'before' },
    })
    // Let the poller see the row so subscribers that come later don't
    // re-read it via primeCursor (they always start from MAX(id)).
    await wait(80)

    const sub = broadcaster.subscribe('tenant:acme:archive')
    await broadcaster.publish('tenant:acme:archive', {
      id: 'evt_live_1',
      event: 'tick',
      data: { phase: 'after' },
    })
    const event = await racedNext(sub, 250)

    expect(event?.id).toBe('evt_live_1')
    await sub.unsubscribe()
  })

  test('default channel authorization denies private-* unless an authorizer says yes', async () => {
    const denied = await broadcaster.authorizeFor('private-orders.42', { id: 'u_alice' })
    expect(denied.authorized).toBe(false)

    broadcaster.authorize('private-orders.*', (channel: string, subject: unknown) => {
      const userId = (subject as { id: string }).id
      const orderId = channel.slice('private-orders.'.length)
      return orderId === '42' && userId === 'u_alice'
    })

    const allowed = await broadcaster.authorizeFor('private-orders.42', { id: 'u_alice' })
    expect(allowed.authorized).toBe(true)

    const otherUser = await broadcaster.authorizeFor('private-orders.42', { id: 'u_eve' })
    expect(otherUser.authorized).toBe(false)
  })

  test('BroadcastSubscription works as an AsyncIterable (sseResponse-ready)', async () => {
    const sub = broadcaster.subscribe('tenant:acme:iter')

    await broadcaster.publish('tenant:acme:iter', {
      id: 'evt_iter_1',
      event: 'tick',
      data: { n: 1 },
    })
    await broadcaster.publish('tenant:acme:iter', {
      id: 'evt_iter_2',
      event: 'tick',
      data: { n: 2 },
    })

    // Drive the subscription through a `for await` loop — the same shape
    // an SSE handler (`async function* subscribe(ctx)`) uses to feed
    // `sseResponse`. Encoding is covered by sse_response.test.ts; this
    // test proves the cross-process ledger fan-out plugs into
    // AsyncIterable consumption.
    const collected: { id: string; n: number }[] = []
    const deadline = Date.now() + 500
    for await (const event of sub) {
      const data = event.data as { n: number }
      collected.push({ id: event.id, n: data.n })
      if (collected.length >= 2 || Date.now() > deadline) break
    }

    expect(collected).toEqual([
      { id: 'evt_iter_1', n: 1 },
      { id: 'evt_iter_2', n: 2 },
    ])

    // Iterating from a controller-style handler — `sseResponse(asyncIter)` —
    // is exercised at the unit level in packages/http/tests/sse with a
    // synthetic AsyncIterable; combining the two here would re-test
    // encoding without adding coverage.
  })

  test('sweepOnce deletes rows older than the retention window', async () => {
    // Insert a row dated well outside the default retention.
    await booted.setupDb.execute(
      `INSERT INTO strav_broadcast_events (channel, event_name, event_id, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, now() - interval '1 hour')`,
      ['tenant:acme:sweep', 'old', 'evt_old_1', JSON.stringify({})],
    )
    const before = await rowCount(booted.setupDb, 'tenant:acme:sweep')
    expect(before).toBeGreaterThan(0)

    const deleted = await broadcaster.sweepOnce()
    expect(deleted).toBeGreaterThan(0)

    const after = await rowCount(booted.setupDb, 'tenant:acme:sweep')
    expect(after).toBe(0)
  })
})

// ─── Helpers ──────────────────────────────────────────────────────────────

async function racedNext(
  sub: { next(): Promise<IteratorResult<BroadcastEvent>> },
  timeoutMs: number,
): Promise<BroadcastEvent | undefined> {
  const { value, done } = await Promise.race([
    sub.next(),
    new Promise<IteratorResult<BroadcastEvent>>((r) =>
      setTimeout(() => r({ value: undefined as never, done: true }), timeoutMs),
    ),
  ])
  if (done) return undefined
  return value
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function rowCount(
  db: {
    query: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<T[]>
  },
  channel: string,
): Promise<number> {
  const rows = await db.query<{ count: string | number }>(
    `SELECT count(*)::int AS count FROM strav_broadcast_events WHERE channel = $1`,
    [channel],
  )
  return Number(rows[0]?.count ?? 0)
}
