import { beforeEach, describe, expect, test } from 'bun:test'
import { ConfigError, LogManager } from '@strav/kernel'
import {
  ArrayTransport,
  LogTransport,
  type MailConfig,
  MailManager,
  type Message,
  ResendTransport,
  SendGridTransport,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub LogManager — `array` transports never touch a Logger, so most
 * tests can hand in a stub that simply errors if accidentally exercised.
 * Tests that build the `log` transport use a real `LogManager` further
 * down.
 */
function unusedLogManager(): LogManager {
  const fail = (where: string) => () => {
    throw new Error(`LogManager.${where} called unexpectedly`)
  }
  return {
    channel: fail('channel'),
    default: fail('default'),
  } as unknown as LogManager
}

function arrayOnlyConfig(overrides: Partial<MailConfig> = {}): MailConfig {
  return {
    default: 'array',
    transports: { array: { driver: 'array' } },
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction + validation
// ─────────────────────────────────────────────────────────────────────────────

describe('MailManager — config validation', () => {
  test('default transport must exist in transports', () => {
    expect(
      () =>
        new MailManager(
          { default: 'missing', transports: { array: { driver: 'array' } } },
          unusedLogManager(),
        ),
    ).toThrow(/default transport "missing" is not defined/)
  })

  test('unknown driver is rejected at construction', () => {
    expect(
      () =>
        new MailManager(
          {
            default: 'rogue',
            transports: { rogue: { driver: 'smtp' } as unknown as { driver: 'array' } },
          },
          unusedLogManager(),
        ),
    ).toThrow(/transport "rogue" has unknown driver "smtp"/)
  })

  test('valid config constructs without error', () => {
    expect(() => new MailManager(arrayOnlyConfig(), unusedLogManager())).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// send + via
// ─────────────────────────────────────────────────────────────────────────────

describe('MailManager — send + via', () => {
  let manager: MailManager

  beforeEach(() => {
    manager = new MailManager(arrayOnlyConfig(), unusedLogManager())
  })

  test('send() routes through the default transport', async () => {
    await manager.send({ to: 'a@x', subject: 'hi', text: 'h' })
    const t = manager.via() as ArrayTransport
    expect(t.count).toBe(1)
    expect(t.messages[0]?.subject).toBe('hi')
  })

  test('via() returns the same transport instance on repeated calls', () => {
    const a = manager.via()
    const b = manager.via()
    const c = manager.via('array')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  test('via("unknown") throws ConfigError', () => {
    expect(() => manager.via('missing')).toThrow(ConfigError)
    expect(() => manager.via('missing')).toThrow(/transport "missing" is not defined/)
  })

  test('via("name").send routes through the named transport', async () => {
    const m = new MailManager(
      {
        default: 'main',
        transports: { main: { driver: 'array' }, priority: { driver: 'array' } },
      },
      unusedLogManager(),
    )
    await m.send({ to: 'a@x', subject: 'main', text: 'm' })
    await m.via('priority').send({ to: 'b@x', subject: 'priority', text: 'p' })
    expect((m.via() as ArrayTransport).count).toBe(1)
    expect((m.via('priority') as ArrayTransport).count).toBe(1)
    expect((m.via() as ArrayTransport).messages[0]?.subject).toBe('main')
    expect((m.via('priority') as ArrayTransport).messages[0]?.subject).toBe('priority')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// default-from substitution
// ─────────────────────────────────────────────────────────────────────────────

describe('MailManager — default `from`', () => {
  test('fills in `from` when the message omits one', async () => {
    const manager = new MailManager(
      arrayOnlyConfig({ from: 'noreply@example.com' }),
      unusedLogManager(),
    )
    await manager.send({ to: 'a@x', subject: 's', text: 't' })
    const sent = (manager.via() as ArrayTransport).messages[0] as Message
    expect(sent.from).toBe('noreply@example.com')
  })

  test('does not override a `from` already set on the message', async () => {
    const manager = new MailManager(
      arrayOnlyConfig({ from: 'noreply@example.com' }),
      unusedLogManager(),
    )
    await manager.send({ to: 'a@x', from: 'caller@x', subject: 's', text: 't' })
    const sent = (manager.via() as ArrayTransport).messages[0] as Message
    expect(sent.from).toBe('caller@x')
  })

  test('omits `from` when neither the config nor the message has one', async () => {
    const manager = new MailManager(arrayOnlyConfig(), unusedLogManager())
    await manager.send({ to: 'a@x', subject: 's', text: 't' })
    const sent = (manager.via() as ArrayTransport).messages[0] as Message
    expect(sent.from).toBeUndefined()
  })

  test('accepts structured MailRecipient as default from', async () => {
    const manager = new MailManager(
      arrayOnlyConfig({ from: { email: 'noreply@example.com', name: 'Acme' } }),
      unusedLogManager(),
    )
    await manager.send({ to: 'a@x', subject: 's', text: 't' })
    const sent = (manager.via() as ArrayTransport).messages[0] as Message
    expect(sent.from).toEqual({ email: 'noreply@example.com', name: 'Acme' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `log` transport build path
// ─────────────────────────────────────────────────────────────────────────────

describe('MailManager — `log` transport build path', () => {
  test('builds a LogTransport from the configured channel', async () => {
    const logManager = new LogManager({
      default: 'main',
      level: 'silent',
      channels: { main: { driver: 'stderr' } },
    })
    const manager = new MailManager(
      {
        default: 'log',
        transports: { log: { driver: 'log' } },
      },
      logManager,
    )
    const t = manager.via('log')
    expect(t).toBeInstanceOf(LogTransport)
    // Send is a no-op observably — the underlying Logger is at level 'silent',
    // so nothing reaches stderr. The test asserts the build path works
    // without throwing.
    await manager.send({ to: 'a@x', subject: 's', text: 't' })
    await logManager.shutdown()
  })

  test('respects a custom channel name', async () => {
    const logManager = new LogManager({
      default: 'main',
      level: 'silent',
      channels: {
        main: { driver: 'stderr' },
        mail: { driver: 'stderr' },
      },
    })
    const manager = new MailManager(
      {
        default: 'log',
        transports: { log: { driver: 'log', channel: 'mail' } },
      },
      logManager,
    )
    const t = manager.via('log')
    expect(t).toBeInstanceOf(LogTransport)
    await logManager.shutdown()
  })

  test('rejects a missing channel via LogManager.channel', async () => {
    const logManager = new LogManager({
      default: 'main',
      level: 'silent',
      channels: { main: { driver: 'stderr' } },
    })
    const manager = new MailManager(
      {
        default: 'log',
        transports: { log: { driver: 'log', channel: 'does-not-exist' } },
      },
      logManager,
    )
    expect(() => manager.via('log')).toThrow(/channel "does-not-exist" is not defined/)
    await logManager.shutdown()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe('MailManager — shutdown', () => {
  test('shutdown() calls close() on cached transports and clears the cache', async () => {
    let closes = 0
    class ClosingTransport {
      async send() {}
      async close() {
        closes += 1
      }
    }
    // Bypass the public buildTransport switch — inject the test transport
    // directly into the cache.
    const manager = new MailManager(arrayOnlyConfig(), unusedLogManager())
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the private cache for the test
    ;(manager as any).cache.set('array', new ClosingTransport())
    await manager.shutdown()
    expect(closes).toBe(1)
    // Cache cleared — next `via('array')` builds a fresh ArrayTransport.
    const fresh = manager.via('array')
    expect(fresh).toBeInstanceOf(ArrayTransport)
  })

  test('shutdown() swallows close() errors', async () => {
    class WedgedTransport {
      async send() {}
      async close() {
        throw new Error('wedged')
      }
    }
    const manager = new MailManager(arrayOnlyConfig(), unusedLogManager())
    // biome-ignore lint/suspicious/noExplicitAny: see above
    ;(manager as any).cache.set('array', new WedgedTransport())
    await expect(manager.shutdown()).resolves.toBeUndefined()
  })

  test('shutdown() is a no-op when no transports are cached', async () => {
    const manager = new MailManager(arrayOnlyConfig(), unusedLogManager())
    await expect(manager.shutdown()).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HTTP transports — build path + apiKey validation
// ─────────────────────────────────────────────────────────────────────────────

describe('MailManager — resend / sendgrid build path', () => {
  test('builds a ResendTransport from config', () => {
    const m = new MailManager(
      {
        default: 'resend',
        transports: { resend: { driver: 'resend', apiKey: 're_test' } },
      },
      unusedLogManager(),
    )
    expect(m.via('resend')).toBeInstanceOf(ResendTransport)
  })

  test('builds a SendGridTransport from config', () => {
    const m = new MailManager(
      {
        default: 'sendgrid',
        transports: { sendgrid: { driver: 'sendgrid', apiKey: 'SG.test' } },
      },
      unusedLogManager(),
    )
    expect(m.via('sendgrid')).toBeInstanceOf(SendGridTransport)
  })

  test('empty apiKey is rejected at config validation', () => {
    expect(
      () =>
        new MailManager(
          {
            default: 'resend',
            transports: { resend: { driver: 'resend', apiKey: '' } },
          },
          unusedLogManager(),
        ),
    ).toThrow(/requires a non-empty `apiKey`/)
  })

  test('endpoint override propagates through the manager', async () => {
    const calls: string[] = []
    const stub = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const m = new MailManager(
      {
        default: 'resend',
        transports: {
          resend: { driver: 'resend', apiKey: 'k', endpoint: 'https://eu.resend.example' },
        },
      },
      unusedLogManager(),
    )
    // Reach into the cache to swap in our fetch stub — buildTransport
    // doesn't accept a `fetch` option, that's the unit-test entry point.
    const t = m.via('resend') as ResendTransport
    // biome-ignore lint/suspicious/noExplicitAny: stubbing private field for the test
    ;(t as any).fetchFn = stub
    await t.send({ to: 'a@x', from: 'b@x', subject: 's', text: 't' })
    expect(calls[0]).toBe('https://eu.resend.example/emails')
  })
})
