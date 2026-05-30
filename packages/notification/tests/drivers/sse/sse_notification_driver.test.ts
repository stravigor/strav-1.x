import { describe, expect, test } from 'bun:test'
import type { SSEEvent } from '@strav/http'
import { SSENotificationDriver } from '../../../src/drivers/sse/index.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'
import { NotificationDeliveryError } from '../../../src/notification_error.ts'

const ctx = (id = 'n_test_1') => ({ id, dispatchedAt: new Date('2026-05-30T08:30:00Z') })
const alice: Notifiable = { id: 'u_1', notifiableType: 'User' }

class StringPing extends BaseNotification {
  constructor(private readonly text: string) {
    super()
  }
  override via(): readonly string[] {
    return ['sse']
  }
  toSSE(): string {
    return this.text
  }
}

class StructuredPing extends BaseNotification {
  constructor(private readonly event: SSEEvent) {
    super()
  }
  override via(): readonly string[] {
    return ['sse']
  }
  toSSE(): SSEEvent {
    return this.event
  }
}

class ThrowingPing extends BaseNotification {
  override via(): readonly string[] {
    return ['sse']
  }
  toSSE(): SSEEvent {
    throw new Error('boom from hook')
  }
}

class NoHook extends BaseNotification {
  override via(): readonly string[] {
    return ['sse']
  }
}

/** Pull the next event without blocking the test forever. */
async function nextWithin<T>(iter: AsyncIterator<T>, ms = 200): Promise<IteratorResult<T>> {
  return await Promise.race<IteratorResult<T>>([
    iter.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

describe('SSENotificationDriver', () => {
  test('string hook → SSE event with auto id + event name', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()

    const dispatch = driver.send(alice, new StringPing('hello'), ctx())
    const event = (await nextWithin(iter)).value as SSEEvent
    const result = await dispatch

    expect(event.data).toBe('hello')
    expect(event.id).toBe('n_test_1') // defaults to context id
    expect(event.event).toBe('StringPing') // defaults to notification class
    expect(result).toEqual({ channel: 'sse', delivered: true, reference: 'n_test_1' })

    await iter.return?.(undefined)
  })

  test('structured hook — hook-provided id/event win over defaults', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()

    void driver.send(
      alice,
      new StructuredPing({ data: { x: 1 }, id: 'custom-id', event: 'custom-event' }),
      ctx(),
    )
    const event = (await nextWithin(iter)).value as SSEEvent
    expect(event).toEqual({ data: { x: 1 }, id: 'custom-id', event: 'custom-event' })

    await iter.return?.(undefined)
  })

  test('delivered: false when no subscribers exist for the notifiable', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const result = await driver.send(alice, new StringPing('alone'), ctx())
    expect(result).toEqual({ channel: 'sse', delivered: false })
  })

  test('delivered: false when notification has no toSSE hook', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    // Subscribe so the "no subscribers" branch doesn't mask the "no hook" branch.
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()

    const result = await driver.send(alice, new NoHook(), ctx())
    expect(result).toEqual({ channel: 'sse', delivered: false })

    await iter.return?.(undefined)
  })

  test('fans out to every subscriber for the same notifiable', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const a = driver.subscribe('u_1', { notifiableType: 'User' })[Symbol.asyncIterator]()
    const b = driver.subscribe('u_1', { notifiableType: 'User' })[Symbol.asyncIterator]()

    void driver.send(alice, new StringPing('to-both'), ctx())
    const [ea, eb] = await Promise.all([nextWithin(a), nextWithin(b)])

    expect((ea.value as SSEEvent).data).toBe('to-both')
    expect((eb.value as SSEEvent).data).toBe('to-both')
    expect(driver.subscriberCount('u_1', { notifiableType: 'User' })).toBe(2)

    await a.return?.(undefined)
    await b.return?.(undefined)
    expect(driver.subscriberCount('u_1', { notifiableType: 'User' })).toBe(0)
  })

  test('routing key is (id, notifiableType) — different types do NOT receive', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const userSub = driver.subscribe('u_1', { notifiableType: 'User' })[Symbol.asyncIterator]()
    const orgSub = driver.subscribe('u_1', { notifiableType: 'Org' })[Symbol.asyncIterator]()

    void driver.send(alice, new StringPing('to-user'), ctx())

    const userEvent = await nextWithin(userSub)
    expect((userEvent.value as SSEEvent).data).toBe('to-user')

    // Org subscriber doesn't see it — assert by racing a short timeout.
    let orgReceived = false
    const orgPoll = (async () => {
      const r = await nextWithin(orgSub, 50).catch(() => null)
      if (r !== null) orgReceived = true
    })()
    await orgPoll
    expect(orgReceived).toBe(false)

    await userSub.return?.(undefined)
    await orgSub.return?.(undefined)
  })

  test('iterator.return() detaches the subscriber from the registry', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()
    expect(driver.subscriberCount('u_1', { notifiableType: 'User' })).toBe(1)

    await iter.return?.(undefined)
    expect(driver.subscriberCount('u_1', { notifiableType: 'User' })).toBe(0)

    // Subsequent dispatch is a no-op (no subscribers → delivered: false).
    const r = await driver.send(alice, new StringPing('orphan'), ctx())
    expect(r.delivered).toBe(false)
  })

  test('queued events are drained in order', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()

    // Three dispatches BEFORE the consumer pulls — all queue up.
    await driver.send(alice, new StringPing('a'), ctx('n_a'))
    await driver.send(alice, new StringPing('b'), ctx('n_b'))
    await driver.send(alice, new StringPing('c'), ctx('n_c'))

    const e1 = (await nextWithin(iter)).value as SSEEvent
    const e2 = (await nextWithin(iter)).value as SSEEvent
    const e3 = (await nextWithin(iter)).value as SSEEvent

    expect([e1.data, e2.data, e3.data]).toEqual(['a', 'b', 'c'])

    await iter.return?.(undefined)
  })

  test('bounded queue drops oldest when consumer falls behind', async () => {
    const driver = new SSENotificationDriver({ name: 'sse', queueSize: 2 })
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()

    // Four dispatches, queue cap is 2 — oldest two get dropped.
    await driver.send(alice, new StringPing('1'), ctx())
    await driver.send(alice, new StringPing('2'), ctx())
    await driver.send(alice, new StringPing('3'), ctx())
    await driver.send(alice, new StringPing('4'), ctx())

    const e1 = (await nextWithin(iter)).value as SSEEvent
    const e2 = (await nextWithin(iter)).value as SSEEvent
    expect([e1.data, e2.data]).toEqual(['3', '4'])

    await iter.return?.(undefined)
  })

  test('hook throw is wrapped as NotificationDeliveryError', async () => {
    const driver = new SSENotificationDriver({ name: 'sse' })
    const stream = driver.subscribe('u_1', { notifiableType: 'User' })
    const iter = stream[Symbol.asyncIterator]()

    let caught: unknown
    try {
      await driver.send(alice, new ThrowingPing(), ctx())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as NotificationDeliveryError).context['notification']).toBe('ThrowingPing')

    await iter.return?.(undefined)
  })
})
