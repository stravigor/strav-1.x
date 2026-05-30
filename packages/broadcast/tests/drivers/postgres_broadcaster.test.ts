/**
 * Unit-level tests against an in-memory `db` stub — exercises the
 * polling cursor, retention SQL shape, and the fan-out path without
 * spinning up Postgres. The real-DB pass lives in the e2e suite.
 */

import { describe, expect, test } from 'bun:test'
import {
  PostgresBroadcaster,
  type PostgresBroadcasterDatabase,
} from '../../src/drivers/postgres/index.ts'
import type { BroadcastEvent } from '../../src/index.ts'

interface LedgerRow {
  id: number
  channel: string
  event_name: string
  event_id: string
  data: unknown
  created_at: Date
}

interface StubDb extends PostgresBroadcasterDatabase {
  rows: LedgerRow[]
  executed: { sql: string; params: readonly unknown[] }[]
  insert(channel: string, event: string, id: string, data: unknown, createdAt?: Date): void
}

function makeStubDb(): StubDb {
  const rows: LedgerRow[] = []
  const executed: { sql: string; params: readonly unknown[] }[] = []
  let nextId = 1
  return {
    rows,
    executed,
    insert(channel, event, id, data, createdAt = new Date()) {
      rows.push({
        id: nextId++,
        channel,
        event_name: event,
        event_id: id,
        data,
        created_at: createdAt,
      })
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      executed.push({ sql, params })
      if (sql.includes('MAX("id")')) {
        const max = rows.length === 0 ? null : Math.max(...rows.map((r) => r.id))
        return [{ max }] as unknown as T[]
      }
      if (sql.includes('FROM "strav_broadcast_events"') && sql.includes('"id" > $1')) {
        const lastId = BigInt(params[0] as string)
        return rows
          .filter((r) => BigInt(r.id) > lastId)
          .sort((a, b) => a.id - b.id)
          .map((r) => ({
            id: r.id,
            channel: r.channel,
            event_name: r.event_name,
            event_id: r.event_id,
            data: r.data,
          })) as unknown as T[]
      }
      return []
    },
    async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
      executed.push({ sql, params })
      if (sql.startsWith('INSERT INTO "strav_broadcast_events"')) {
        const [channel, eventName, eventId, dataJson] = params as string[]
        rows.push({
          id: nextId++,
          channel: channel!,
          event_name: eventName!,
          event_id: eventId!,
          data: JSON.parse(dataJson!),
          created_at: new Date(),
        })
        return 1
      }
      if (sql.startsWith('DELETE FROM "strav_broadcast_events"')) {
        const seconds = Number((params[0] as string) ?? '0')
        const cutoff = Date.now() - seconds * 1000
        const before = rows.length
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.created_at.getTime() < cutoff) rows.splice(i, 1)
        }
        return before - rows.length
      }
      return 0
    },
  }
}

function ev(id: string, event = 'tick', data: unknown = { id }): BroadcastEvent {
  return { id, event, data }
}

describe('PostgresBroadcaster', () => {
  test('publish() INSERTs a row into strav_broadcast_events', async () => {
    const db = makeStubDb()
    const b = new PostgresBroadcaster({ db })

    await b.publish('orders.42', ev('e1', 'order.paid', { amount: 4900 }))

    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({
      channel: 'orders.42',
      event_name: 'order.paid',
      event_id: 'e1',
      data: { amount: 4900 },
    })
    await b.close()
  })

  test('subscribers receive events published after they subscribe', async () => {
    const db = makeStubDb()
    const b = new PostgresBroadcaster({ db })
    const sub = b.subscribe('orders.42')

    await b.publish('orders.42', ev('e1'))
    await b.pollOnce()

    const { value } = await sub.next()
    expect(value?.id).toBe('e1')
    await sub.unsubscribe()
    await b.close()
  })

  test('historical events before subscribe are NOT replayed', async () => {
    const db = makeStubDb()
    db.insert('orders.42', 'order.paid', 'historical-1', { amount: 1 })
    db.insert('orders.42', 'order.paid', 'historical-2', { amount: 2 })

    const b = new PostgresBroadcaster({ db })
    const sub = b.subscribe('orders.42')

    // Polling once should not emit historical events — primeCursor jumped to MAX(id).
    await b.pollOnce()

    await b.publish('orders.42', ev('live-1'))
    await b.pollOnce()

    const { value } = await sub.next()
    expect(value?.id).toBe('live-1')
    await sub.unsubscribe()
    await b.close()
  })

  test('fan-out preserves event order', async () => {
    const db = makeStubDb()
    const b = new PostgresBroadcaster({ db })
    const sub = b.subscribe('orders.42')

    await b.publish('orders.42', ev('e1'))
    await b.publish('orders.42', ev('e2'))
    await b.publish('orders.42', ev('e3'))
    await b.pollOnce()

    expect((await sub.next()).value?.id).toBe('e1')
    expect((await sub.next()).value?.id).toBe('e2')
    expect((await sub.next()).value?.id).toBe('e3')
    await sub.unsubscribe()
    await b.close()
  })

  test('does not cross channels', async () => {
    const db = makeStubDb()
    const b = new PostgresBroadcaster({ db })
    const subA = b.subscribe('channel-a')
    const subB = b.subscribe('channel-b')

    await b.publish('channel-a', ev('a1'))
    await b.publish('channel-b', ev('b1'))
    await b.pollOnce()

    expect((await subA.next()).value?.id).toBe('a1')
    expect((await subB.next()).value?.id).toBe('b1')
    await subA.unsubscribe()
    await subB.unsubscribe()
    await b.close()
  })

  test('sweepOnce deletes rows older than the retention window', async () => {
    const db = makeStubDb()
    db.insert('orders.42', 'old', 'old-1', {}, new Date(Date.now() - 10 * 60 * 1000))
    db.insert('orders.42', 'recent', 'recent-1', {}, new Date())

    const b = new PostgresBroadcaster({ db, retentionSeconds: 300 })
    const deleted = await b.sweepOnce()

    expect(deleted).toBe(1)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]?.event_id).toBe('recent-1')
    await b.close()
  })

  test('close() stops the poll loop', async () => {
    const db = makeStubDb()
    const b = new PostgresBroadcaster({ db, pollIntervalMs: 5 })
    const sub = b.subscribe('orders.42')
    await b.publish('orders.42', ev('e1'))

    // Give the poll loop a turn.
    await new Promise((r) => setTimeout(r, 20))
    await sub.unsubscribe()
    await b.close()

    const executedBefore = db.executed.length
    await new Promise((r) => setTimeout(r, 20))
    expect(db.executed.length).toBe(executedBefore)
  })

  test('publish surfaces non-JSON-serialisable payloads as BroadcastPublishError', async () => {
    const db = makeStubDb()
    const b = new PostgresBroadcaster({ db })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    await expect(
      b.publish('orders.42', { id: 'bad', event: 'oops', data: circular }),
    ).rejects.toMatchObject({ code: 'broadcast.publish' })
    await b.close()
  })
})
