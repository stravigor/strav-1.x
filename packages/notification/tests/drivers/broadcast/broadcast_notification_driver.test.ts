import { describe, expect, test } from 'bun:test'
import { MemoryBroadcaster } from '@strav/broadcast'
import { BroadcastNotificationDriver } from '../../../src/drivers/broadcast/index.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'
import { NotificationDeliveryError } from '../../../src/notification_error.ts'

class OrderPaid extends BaseNotification {
  constructor(private readonly payload: { invoiceId: string; amount: number }) {
    super()
  }
  override via(): readonly string[] {
    return ['broadcast']
  }
  toBroadcast(notifiable: Notifiable) {
    return {
      channel: `private-orders.${notifiable.id}`,
      event: 'order.paid',
      data: this.payload,
    }
  }
}

class DefaultsEventName extends BaseNotification {
  override via(): readonly string[] {
    return ['broadcast']
  }
  toBroadcast(_n: Notifiable) {
    return { channel: 'news', data: { hello: 'world' } }
  }
}

class NoHook extends BaseNotification {
  override via(): readonly string[] {
    return ['broadcast']
  }
}

class HookThrows extends BaseNotification {
  override via(): readonly string[] {
    return ['broadcast']
  }
  toBroadcast(_n: Notifiable): never {
    throw new Error('hook failure')
  }
}

const alice: Notifiable = { id: 'u_1', notifiableType: 'User' }
const context = { id: 'n_01J', dispatchedAt: new Date() }

describe('BroadcastNotificationDriver', () => {
  test('publishes via the configured Broadcaster with class name as event', async () => {
    const broadcaster = new MemoryBroadcaster()
    const sub = broadcaster.subscribe('news')
    const driver = new BroadcastNotificationDriver({ name: 'broadcast', broadcaster })

    const result = await driver.send(alice, new DefaultsEventName(), context)

    expect(result).toEqual({ channel: 'broadcast', delivered: true, reference: 'n_01J' })
    const { value } = await sub.next()
    expect(value).toEqual({
      id: 'n_01J',
      event: 'DefaultsEventName',
      data: { hello: 'world' },
    })
    await sub.unsubscribe()
  })

  test('uses payload.event when provided', async () => {
    const broadcaster = new MemoryBroadcaster()
    const sub = broadcaster.subscribe('private-orders.u_1')
    const driver = new BroadcastNotificationDriver({ name: 'broadcast', broadcaster })

    await driver.send(alice, new OrderPaid({ invoiceId: 'inv_1', amount: 4900 }), context)

    const { value } = await sub.next()
    expect(value?.event).toBe('order.paid')
    expect(value?.data).toEqual({ invoiceId: 'inv_1', amount: 4900 })
    await sub.unsubscribe()
  })

  test('threads context.id through as the event id', async () => {
    const broadcaster = new MemoryBroadcaster()
    const sub = broadcaster.subscribe('news')
    const driver = new BroadcastNotificationDriver({ name: 'broadcast', broadcaster })

    await driver.send(alice, new DefaultsEventName(), context)

    const { value } = await sub.next()
    expect(value?.id).toBe('n_01J')
    await sub.unsubscribe()
  })

  test('skips delivery when notification has no toBroadcast hook', async () => {
    const broadcaster = new MemoryBroadcaster()
    const driver = new BroadcastNotificationDriver({ name: 'broadcast', broadcaster })

    const result = await driver.send(alice, new NoHook(), context)

    expect(result).toEqual({ channel: 'broadcast', delivered: false })
    expect(broadcaster.subscriberCount('news')).toBe(0)
  })

  test('wraps a thrown hook into NotificationDeliveryError', async () => {
    const broadcaster = new MemoryBroadcaster()
    const driver = new BroadcastNotificationDriver({ name: 'broadcast', broadcaster })

    let caught: unknown
    try {
      await driver.send(alice, new HookThrows(), context)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as NotificationDeliveryError).context['notification']).toBe('HookThrows')
  })

  test('wraps a publish failure into NotificationDeliveryError', async () => {
    class ThrowingBroadcaster extends MemoryBroadcaster {
      override async publish(): Promise<void> {
        throw new Error('publish failed')
      }
    }
    const driver = new BroadcastNotificationDriver({
      name: 'broadcast',
      broadcaster: new ThrowingBroadcaster(),
    })

    let caught: unknown
    try {
      await driver.send(alice, new DefaultsEventName(), context)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as NotificationDeliveryError).context['broadcastChannel']).toBe('news')
  })
})
