/**
 * Unit tests against a stubbed pub/sub client — exercises the
 * subscribe/publish round-trip, upstream ref-counting, and shutdown
 * cleanup without booting a real Redis. A real-Redis pass would live
 * alongside the existing broadcast e2e fixture; the pub/sub semantics
 * tested here are deterministic enough that the stub is the primary
 * surface.
 */

import { describe, expect, test } from 'bun:test'
import { RedisBroadcaster, type RedisBroadcasterClient } from '../../src/drivers/redis/index.ts'
import type { BroadcastEvent } from '../../src/index.ts'

interface StubClient extends RedisBroadcasterClient {
  /** Listeners keyed by channel. */
  listeners: Map<string, (message: string, channel: string) => void>
  published: { channel: string; message: string }[]
  closed: boolean
}

function makeStubPub(): StubClient {
  return {
    listeners: new Map(),
    published: [],
    closed: false,
    async publish(channel, message) {
      this.published.push({ channel, message })
      return 0
    },
    async subscribe() {
      throw new Error('pub client should not be used to subscribe')
    },
    async unsubscribe() {},
    close() {
      this.closed = true
    },
  }
}

function makeStubSub(): StubClient {
  return {
    listeners: new Map(),
    published: [],
    closed: false,
    async publish() {
      return 0
    },
    async subscribe(channel, listener) {
      this.listeners.set(channel, listener)
      return 1
    },
    async unsubscribe(channel) {
      this.listeners.delete(channel)
    },
    close() {
      this.closed = true
    },
  }
}

function ev(id: string, event = 'tick', data: unknown = { id }): BroadcastEvent {
  return { id, event, data }
}

/** Wait one microtask turn so the async `ensureUpstream` settles. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('RedisBroadcaster', () => {
  test('publish JSON-encodes the event and forwards to PUBLISH', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    await b.publish('orders.42', ev('e1'))
    expect(pub.published).toHaveLength(1)
    expect(pub.published[0]).toEqual({
      channel: 'orders.42',
      message: JSON.stringify(ev('e1')),
    })
    await b.close()
  })

  test('subscribe opens one upstream subscription and fans out to local subscribers', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    const a = b.subscribe('orders.42')
    const c = b.subscribe('orders.42')
    await tick()

    // Two in-process subscribers, one upstream SUBSCRIBE.
    expect(sub.listeners.size).toBe(1)
    expect(b.upstreamSubscribed('orders.42')).toBe(true)

    const listener = sub.listeners.get('orders.42')
    if (listener === undefined) throw new Error('listener not registered')
    listener(JSON.stringify(ev('e1')), 'orders.42')

    expect((await a.next()).value).toEqual(ev('e1'))
    expect((await c.next()).value).toEqual(ev('e1'))
    await a.unsubscribe()
    await c.unsubscribe()
    await b.close()
  })

  test('upstream UNSUBSCRIBE fires when the last local subscriber drops', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    const a = b.subscribe('news')
    const c = b.subscribe('news')
    await tick()
    expect(sub.listeners.has('news')).toBe(true)

    await a.unsubscribe()
    expect(sub.listeners.has('news')).toBe(true) // still one subscriber

    await c.unsubscribe()
    expect(sub.listeners.has('news')).toBe(false)
    expect(b.upstreamSubscribed('news')).toBe(false)
    await b.close()
  })

  test('re-subscribing after the last drop re-issues SUBSCRIBE', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    const a = b.subscribe('news')
    await tick()
    await a.unsubscribe()
    expect(sub.listeners.has('news')).toBe(false)

    const c = b.subscribe('news')
    await tick()
    expect(sub.listeners.has('news')).toBe(true)

    const listener = sub.listeners.get('news')
    if (listener === undefined) throw new Error('listener not registered')
    listener(JSON.stringify(ev('e1')), 'news')
    expect((await c.next()).value).toEqual(ev('e1'))
    await c.unsubscribe()
    await b.close()
  })

  test('non-JSON payloads on a subscribed channel are dropped silently', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    const a = b.subscribe('news')
    await tick()
    const listener = sub.listeners.get('news')
    if (listener === undefined) throw new Error('listener not registered')

    // Garbage from a third party sharing the Redis instance.
    listener('not json', 'news')
    // A real event still gets through.
    listener(JSON.stringify(ev('e1')), 'news')

    expect((await a.next()).value).toEqual(ev('e1'))
    await a.unsubscribe()
    await b.close()
  })

  test('breaking out of `for await` releases the upstream subscription', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    const subscription = b.subscribe('news')
    await tick()

    void (async () => {
      const listener = sub.listeners.get('news')
      if (listener === undefined) return
      listener(JSON.stringify(ev('e1')), 'news')
      listener(JSON.stringify(ev('e2')), 'news')
    })()

    let count = 0
    for await (const _event of subscription) {
      count++
      if (count >= 2) break
    }
    expect(count).toBe(2)
    // return() ran on break → upstream dropped.
    expect(sub.listeners.has('news')).toBe(false)
    await b.close()
  })

  test('close() unsubscribes all upstream channels and closes owned clients only', async () => {
    const pub = makeStubPub()
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    b.subscribe('a')
    b.subscribe('b')
    await tick()
    expect(sub.listeners.size).toBe(2)

    await b.close()
    expect(sub.listeners.size).toBe(0)
    // Clients were injected, so close() must NOT close them.
    expect(pub.closed).toBe(false)
    expect(sub.closed).toBe(false)
  })

  test('publish errors are wrapped in BroadcastPublishError', async () => {
    const pub = makeStubPub()
    pub.publish = async () => {
      throw new Error('connection refused')
    }
    const sub = makeStubSub()
    const b = new RedisBroadcaster({ pub, sub })

    let caught: unknown
    try {
      await b.publish('news', ev('e1'))
    } catch (err) {
      caught = err
    }
    expect((caught as Error).name).toBe('BroadcastPublishError')
    await b.close()
  })

  test('constructor rejects partial client injection', () => {
    const pub = makeStubPub()
    expect(() => new RedisBroadcaster({ pub })).toThrow(/both `pub` and `sub`/)
  })

  test('constructor rejects missing url when no clients injected', () => {
    expect(() => new RedisBroadcaster({})).toThrow(/url.*required/i)
  })
})
