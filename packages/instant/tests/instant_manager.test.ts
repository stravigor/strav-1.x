/**
 * Smoke tests for `InstantManager` — driver routing, extension
 * registration, capability surface, webhook delegation. Uses a
 * tiny `RecordingDriver` defined inline (no real network).
 */

import { describe, expect, test } from 'bun:test'
import {
  type InstantCapability,
  InstantConfigError,
  type InstantDriver,
  InstantManager,
  type OutgoingMessage,
  ProviderUnsupportedError,
  type SendResult,
  UnknownProviderError,
  type WebhookEvent,
  type WebhookOps,
} from '../src/index.ts'

class RecordingDriver implements InstantDriver {
  readonly name = 'mock'
  readonly instanceName: string
  readonly capabilities: ReadonlySet<InstantCapability>
  readonly sent: Array<{ to: string; message: OutgoingMessage }> = []
  readonly webhook: WebhookOps

  constructor(opts: { instanceName: string; capabilities?: ReadonlySet<InstantCapability> }) {
    this.instanceName = opts.instanceName
    this.capabilities =
      opts.capabilities ??
      (new Set<InstantCapability>([
        'send.text',
        'webhook.signature',
        'webhook.parse',
      ]) as ReadonlySet<InstantCapability>)
    this.webhook = {
      verifySignature: (_body, sig) => sig === 'good',
      parse: (body): WebhookEvent[] => [
        {
          provider: 'mock',
          type: 'message.text',
          messageId: 'm1',
          text: body,
          userId: 'u1',
          timestamp: new Date(0),
          source: 'user',
          raw: { body },
        },
      ],
    }
  }

  async send(to: string, message: OutgoingMessage): Promise<SendResult> {
    this.sent.push({ to, message })
    return { provider: 'mock', accepted: true, messageId: `m_${this.sent.length}` }
  }
}

function makeManager() {
  const manager = new InstantManager({
    config: {
      default: 'mock',
      providers: { mock: { driver: 'mock' }, secondary: { driver: 'mock' } },
    },
  })
  manager.extend('mock', ({ instanceName }) => new RecordingDriver({ instanceName }))
  return manager
}

describe('InstantManager — driver routing', () => {
  test('resolves default driver lazily + memoizes', () => {
    const manager = makeManager()
    const a = manager.use()
    const b = manager.use()
    expect(a).toBe(b)
    expect(a.instanceName).toBe('mock')
  })

  test('resolves named provider', () => {
    const manager = makeManager()
    const secondary = manager.use('secondary')
    expect(secondary.instanceName).toBe('secondary')
    expect(secondary).not.toBe(manager.use('mock'))
  })

  test('throws UnknownProviderError for unknown name', () => {
    const manager = makeManager()
    expect(() => manager.use('whatsapp')).toThrow(UnknownProviderError)
  })

  test('throws InstantConfigError when default not configured', () => {
    expect(
      () =>
        new InstantManager({
          config: { default: 'missing', providers: {} },
        }),
    ).toThrow(InstantConfigError)
  })

  test('throws InstantConfigError when no driver factory registered', () => {
    const manager = new InstantManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    expect(() => manager.use()).toThrow(InstantConfigError)
  })

  test('useDriver bypasses the factory', () => {
    const manager = new InstantManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    const driver = new RecordingDriver({ instanceName: 'mock' })
    manager.useDriver('mock', driver)
    expect(manager.use()).toBe(driver)
  })
})

describe('InstantManager — send + webhook delegation', () => {
  test('send routes to the default driver and returns SendResult', async () => {
    const manager = makeManager()
    const result = await manager.send('U123', { text: 'hello' })
    expect(result.accepted).toBe(true)
    expect(result.provider).toBe('mock')
    const driver = manager.use() as RecordingDriver
    expect(driver.sent).toEqual([{ to: 'U123', message: { text: 'hello' } }])
  })

  test('verify delegates to driver and returns true / false', () => {
    const manager = makeManager()
    expect(manager.verify('mock', '{}', 'good')).toBe(true)
    expect(manager.verify('mock', '{}', 'bad')).toBe(false)
    expect(manager.verify('mock', '{}', null)).toBe(false)
  })

  test('parseWebhook returns normalized events', () => {
    const manager = makeManager()
    const events = manager.parseWebhook('mock', 'hi')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message.text', text: 'hi', provider: 'mock' })
  })
})

describe('InstantManager — capability gating', () => {
  test('capabilities surface from the driver', () => {
    const manager = makeManager()
    expect(manager.use().capabilities.has('send.text')).toBe(true)
    expect(manager.use().capabilities.has('send.flex')).toBe(false)
  })

  test('partial-capability driver passes through narrowed set', () => {
    const limited = new RecordingDriver({
      instanceName: 'limited',
      capabilities: new Set<InstantCapability>([
        'webhook.signature',
      ]) as ReadonlySet<InstantCapability>,
    })
    const manager = new InstantManager({
      config: { default: 'limited', providers: { limited: { driver: 'mock' } } },
    })
    manager.useDriver('limited', limited)
    expect(manager.use().capabilities.has('send.text')).toBe(false)
    expect(manager.use().capabilities.has('webhook.signature')).toBe(true)
  })

  // Sanity check: ProviderUnsupportedError stays importable.
  test('ProviderUnsupportedError is constructible', () => {
    const err = new ProviderUnsupportedError('mock', 'broadcast')
    expect(err.message).toContain('"broadcast"')
  })
})
