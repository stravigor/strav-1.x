import { describe, expect, test } from 'bun:test'
import { MockNotificationDriver, mockNotificationDriverFactory } from '../src/drivers/mock.ts'
import type { Notifiable } from '../src/notifiable.ts'
import { BaseNotification } from '../src/notification.ts'
import { NotificationConfigError, UnknownChannelError } from '../src/notification_error.ts'
import { NotificationManager } from '../src/notification_manager.ts'

class Welcome extends BaseNotification {
  constructor(public readonly channels: readonly string[] = ['log']) {
    super()
  }
  override via(_n: Notifiable): readonly string[] {
    return this.channels
  }
}

const alice: Notifiable = { id: 'u_1', email: 'a@b.co' }

describe('NotificationManager', () => {
  test('extend + use returns a fresh driver per channel', () => {
    const m = new NotificationManager({
      config: {
        channels: {
          log: { driver: 'mock' },
          archive: { driver: 'mock' },
        },
      },
    })
    m.extend('mock', mockNotificationDriverFactory)
    const a = m.use('log')
    const b = m.use('log')
    const c = m.use('archive')
    expect(a).toBe(b) // memoized
    expect(a).not.toBe(c) // separate channel → separate instance
    expect(a.name).toBe('log')
    expect(c.name).toBe('archive')
  })

  test('use(undefined) without default throws NotificationConfigError', () => {
    const m = new NotificationManager({ config: { channels: { log: { driver: 'mock' } } } })
    expect(() => m.use()).toThrow(NotificationConfigError)
  })

  test('use(name) for unknown channel throws UnknownChannelError', () => {
    const m = new NotificationManager({ config: { channels: { log: { driver: 'mock' } } } })
    m.extend('mock', mockNotificationDriverFactory)
    expect(() => m.use('ghost')).toThrow(UnknownChannelError)
  })

  test('use(name) for unregistered driver throws UnknownChannelError', () => {
    const m = new NotificationManager({ config: { channels: { log: { driver: 'nope' } } } })
    expect(() => m.use('log')).toThrow(UnknownChannelError)
  })

  test('useDriver hand-wires an instance', async () => {
    const m = new NotificationManager({ config: { channels: { log: { driver: 'mock' } } } })
    const stub = new MockNotificationDriver('log')
    m.useDriver('log', stub)
    const result = await m.send(alice, new Welcome(['log']))
    expect(stub.records.length).toBe(1)
    expect(result.deliveries[0]?.delivered).toBe(true)
  })

  test('send fans out to every channel in via() order', async () => {
    const m = new NotificationManager({
      config: {
        channels: { a: { driver: 'mock' }, b: { driver: 'mock' }, c: { driver: 'mock' } },
      },
    })
    m.extend('mock', mockNotificationDriverFactory)
    const result = await m.send(alice, new Welcome(['c', 'a', 'b']))
    expect(result.deliveries.map((d) => d.channel)).toEqual(['c', 'a', 'b'])
    expect(result.deliveries.every((d) => d.delivered)).toBe(true)
  })

  test('driver throw is captured into delivery result, not rethrown', async () => {
    const m = new NotificationManager({ config: { channels: { broken: { driver: 'mock' } } } })
    m.extend('mock', () => ({
      name: 'broken',
      async send() {
        throw new Error('upstream down')
      },
    }))
    const result = await m.send(alice, new Welcome(['broken']))
    expect(result.deliveries[0]).toMatchObject({
      channel: 'broken',
      delivered: false,
    })
    expect(result.deliveries[0]?.error?.message).toBe('upstream down')
  })

  test('default channel throws when set but not configured', () => {
    expect(
      () =>
        new NotificationManager({
          config: {
            default: 'ghost',
            channels: { log: { driver: 'mock' } },
          },
        }),
    ).toThrow(NotificationConfigError)
  })

  test('send dispatches a unique ULID per call, shared across channels', async () => {
    const m = new NotificationManager({
      config: { channels: { a: { driver: 'mock' }, b: { driver: 'mock' } } },
    })
    m.extend('mock', mockNotificationDriverFactory)
    const r1 = await m.send(alice, new Welcome(['a', 'b']))
    const r2 = await m.send(alice, new Welcome(['a', 'b']))
    expect(r1.id).not.toBe(r2.id)
    expect(typeof r1.id).toBe('string')
    expect(r1.id.length).toBeGreaterThan(0)
  })
})
