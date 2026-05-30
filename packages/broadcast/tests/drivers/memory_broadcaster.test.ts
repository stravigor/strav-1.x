import { describe, expect, test } from 'bun:test'
import { type BroadcastEvent, MemoryBroadcaster } from '../../src/index.ts'

function ev(id: string, event = 'tick', data: unknown = { id }): BroadcastEvent {
  return { id, event, data }
}

async function nextEvent(sub: {
  next(): Promise<IteratorResult<BroadcastEvent>>
}): Promise<BroadcastEvent> {
  const { value, done } = await sub.next()
  if (done || value === undefined) throw new Error('subscription closed early')
  return value
}

describe('MemoryBroadcaster', () => {
  test('delivers a published event to a waiting subscriber', async () => {
    const b = new MemoryBroadcaster()
    const sub = b.subscribe('orders.42')
    const received = sub.next()
    await b.publish('orders.42', ev('e1'))
    const { value } = await received
    expect(value).toEqual({ id: 'e1', event: 'tick', data: { id: 'e1' } })
    await sub.unsubscribe()
  })

  test('buffers events when published before next() is called', async () => {
    const b = new MemoryBroadcaster()
    const sub = b.subscribe('orders.42')
    await b.publish('orders.42', ev('e1'))
    await b.publish('orders.42', ev('e2'))
    expect((await nextEvent(sub)).id).toBe('e1')
    expect((await nextEvent(sub)).id).toBe('e2')
    await sub.unsubscribe()
  })

  test('fan-outs to every subscriber on the same channel', async () => {
    const b = new MemoryBroadcaster()
    const a = b.subscribe('news')
    const c = b.subscribe('news')
    await b.publish('news', ev('e1'))
    expect((await nextEvent(a)).id).toBe('e1')
    expect((await nextEvent(c)).id).toBe('e1')
    await a.unsubscribe()
    await c.unsubscribe()
  })

  test('does not cross channels', async () => {
    const b = new MemoryBroadcaster()
    const a = b.subscribe('channel-a')
    const c = b.subscribe('channel-b')
    await b.publish('channel-a', ev('e1'))

    expect((await nextEvent(a)).id).toBe('e1')
    // c.next() resolves only when its own channel publishes — fire a
    // racing publish so the await resolves deterministically.
    setTimeout(() => void b.publish('channel-b', ev('e2')), 0)
    expect((await nextEvent(c)).id).toBe('e2')
    await a.unsubscribe()
    await c.unsubscribe()
  })

  test('unsubscribe closes the iterator', async () => {
    const b = new MemoryBroadcaster()
    const sub = b.subscribe('news')
    await sub.unsubscribe()
    const result = await sub.next()
    expect(result).toEqual({ value: undefined, done: true })
  })

  test('breaking out of `for await` cleans up via return()', async () => {
    const b = new MemoryBroadcaster()
    const sub = b.subscribe('news')
    void (async () => {
      for (let i = 0; i < 3; i++) await b.publish('news', ev(`e${i}`))
    })()

    let count = 0
    for await (const _event of sub) {
      count++
      if (count >= 2) break
    }
    expect(count).toBe(2)
    expect(b.subscriberCount('news')).toBe(0)
  })

  test('drops oldest event when buffer overflows', async () => {
    const dropped: { channel: string; event: BroadcastEvent }[] = []
    const b = new MemoryBroadcaster({
      maxBufferSize: 2,
      onOverflow: (channel, event) => dropped.push({ channel, event }),
    })
    const sub = b.subscribe('news')
    await b.publish('news', ev('e1'))
    await b.publish('news', ev('e2'))
    await b.publish('news', ev('e3')) // overflow — drops e1

    expect((await nextEvent(sub)).id).toBe('e2')
    expect((await nextEvent(sub)).id).toBe('e3')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.event.id).toBe('e1')
    await sub.unsubscribe()
  })

  test('close() ends all pending iterators', async () => {
    const b = new MemoryBroadcaster()
    const a = b.subscribe('news')
    const c = b.subscribe('news')
    const pendingA = a.next()
    const pendingC = c.next()

    await b.close()

    expect(await pendingA).toEqual({ value: undefined, done: true })
    expect(await pendingC).toEqual({ value: undefined, done: true })
  })

  test('subscriberCount tracks subscribers per channel', async () => {
    const b = new MemoryBroadcaster()
    const a = b.subscribe('room.1')
    const c = b.subscribe('room.1')
    const d = b.subscribe('room.2')

    expect(b.subscriberCount('room.1')).toBe(2)
    expect(b.subscriberCount('room.2')).toBe(1)
    expect(b.subscriberCount('room.3')).toBe(0)

    await a.unsubscribe()
    expect(b.subscriberCount('room.1')).toBe(1)
    await c.unsubscribe()
    expect(b.subscriberCount('room.1')).toBe(0)
    await d.unsubscribe()
  })
})

describe('Broadcaster.authorize', () => {
  test('allows non-private channels by default', async () => {
    const b = new MemoryBroadcaster()
    expect(await b.authorizeFor('updates', null)).toEqual({ authorized: true })
  })

  test('denies private-* and presence-* by default', async () => {
    const b = new MemoryBroadcaster()
    expect((await b.authorizeFor('private-orders.42', null)).authorized).toBe(false)
    expect((await b.authorizeFor('presence-room-42', null)).authorized).toBe(false)
  })

  test('exact-name authorizer wins', async () => {
    const b = new MemoryBroadcaster()
    b.authorize('private-orders.42', (_c, subject) => (subject as { id: string }).id === 'u_1')
    expect((await b.authorizeFor('private-orders.42', { id: 'u_1' })).authorized).toBe(true)
    expect((await b.authorizeFor('private-orders.42', { id: 'u_2' })).authorized).toBe(false)
  })

  test('prefix-pattern authorizer matches by leading substring', async () => {
    const b = new MemoryBroadcaster()
    b.authorize('private-orders.*', () => true)
    expect((await b.authorizeFor('private-orders.42', null)).authorized).toBe(true)
    expect((await b.authorizeFor('private-orders.99', null)).authorized).toBe(true)
    expect((await b.authorizeFor('private-invoices.42', null)).authorized).toBe(false)
  })

  test('longest prefix wins', async () => {
    const b = new MemoryBroadcaster()
    b.authorize('private-orders.*', () => true)
    b.authorize('private-orders.special.*', () => false)
    expect((await b.authorizeFor('private-orders.special.42', null)).authorized).toBe(false)
    expect((await b.authorizeFor('private-orders.42', null)).authorized).toBe(true)
  })

  test('passes presence metadata through', async () => {
    const b = new MemoryBroadcaster()
    b.authorize('presence-room-*', (_c, subject) => ({
      authorized: true,
      presence: { id: (subject as { id: string }).id, name: 'Alice' },
    }))
    const result = await b.authorizeFor('presence-room-42', { id: 'u_1' })
    expect(result).toEqual({ authorized: true, presence: { id: 'u_1', name: 'Alice' } })
  })

  test('honors async authorizers', async () => {
    const b = new MemoryBroadcaster()
    b.authorize('private-async', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return true
    })
    expect((await b.authorizeFor('private-async', null)).authorized).toBe(true)
  })
})
