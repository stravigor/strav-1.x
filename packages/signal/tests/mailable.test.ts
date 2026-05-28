import { beforeEach, describe, expect, test } from 'bun:test'
import { Application, ConfigError, ConfigProvider, inject, LoggerProvider } from '@strav/kernel'
import type { JobContext } from '@strav/queue'
import {
  type ArrayTransport,
  Mailable,
  type MailConfig,
  MailManager,
  MailProvider,
  type Message,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface WelcomePayload {
  name: string
}

/** No extra deps — inherits Mailable's constructor + @inject() metadata. */
class WelcomeEmail extends Mailable<WelcomePayload> {
  static override readonly jobName = 'mail.welcome'

  build(payload: WelcomePayload): Message {
    return {
      to: 'recipient@example.com',
      subject: 'Welcome',
      text: `Hi ${payload.name}`,
    }
  }
}

/** Extra dep — redeclares @inject() + constructor + super(mail). */
class UserRepository {
  get(id: string): string {
    return `user-${id}`
  }
}

@inject()
class InvoiceEmail extends Mailable<{ userId: string }> {
  static override readonly jobName = 'mail.invoice'
  constructor(
    mail: MailManager,
    private readonly users: UserRepository,
  ) {
    super(mail)
  }

  async build(payload: { userId: string }): Promise<Message> {
    const name = this.users.get(payload.userId)
    return { to: `${name}@example.com`, subject: 'Invoice', text: 'Your invoice' }
  }
}

function arrayMailConfig(): MailConfig {
  return {
    default: 'array',
    transports: { array: { driver: 'array' } },
  }
}

function bootApp(): Application {
  const app = new Application()
  app.useProviders([
    new ConfigProvider({
      logger: {
        default: 'main',
        level: 'silent',
        channels: { main: { driver: 'stderr' } },
      },
      mail: arrayMailConfig(),
    }),
    new LoggerProvider(),
    new MailProvider(),
  ])
  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Mailable — DI + lifecycle', () => {
  let app: Application

  beforeEach(async () => {
    app = bootApp()
    await app.start({ signalHandlers: false })
  })

  test('subclass with no extra deps inherits @inject() metadata from base', () => {
    // Construct via the container — proves inherited constructor + paramtypes
    // are picked up.
    const m = app.make(WelcomeEmail)
    expect(m).toBeInstanceOf(WelcomeEmail)
    expect(m).toBeInstanceOf(Mailable)
  })

  test('subclass with extra deps resolves all params via @inject()', () => {
    const m = app.make(InvoiceEmail)
    expect(m).toBeInstanceOf(InvoiceEmail)
  })

  test('build() receives the dispatched payload verbatim', async () => {
    const m = app.make(WelcomeEmail)
    const message = await m.build({ name: 'Alice' })
    expect(message.text).toBe('Hi Alice')
  })

  test('inherited handle() builds the message and sends through the default transport', async () => {
    const m = app.make(WelcomeEmail)
    const ctx: JobContext<WelcomePayload> = {
      jobId: 'job-001',
      attempt: 1,
      payload: { name: 'Bob' },
      signal: new AbortController().signal,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Logger stub for test
      log: { info: () => {} } as any,
    }
    await m.handle(ctx)
    const transport = app.resolve(MailManager).via() as ArrayTransport
    expect(transport.count).toBe(1)
    expect(transport.messages[0]?.subject).toBe('Welcome')
    expect(transport.messages[0]?.text).toBe('Hi Bob')
  })

  test('extra-deps subclass build() actually uses the injected dep', async () => {
    const m = app.make(InvoiceEmail)
    const message = await m.build({ userId: 'u-42' })
    expect(message.to).toBe('user-u-42@example.com')
  })

  test('cleanup', async () => {
    await app.shutdown()
  })
})

describe('Mailable — registers as a Job', () => {
  test('jobName is propagated through Job inheritance', () => {
    expect(WelcomeEmail.jobName).toBe('mail.welcome')
    expect(InvoiceEmail.jobName).toBe('mail.invoice')
  })
})

describe('MailManager.send(MailableClass, payload)', () => {
  let app: Application

  beforeEach(async () => {
    app = bootApp()
    await app.start({ signalHandlers: false })
  })

  test('builds + sends through the default transport', async () => {
    const mail = app.resolve(MailManager)
    await mail.send(WelcomeEmail, { name: 'Carol' })
    const transport = mail.via() as ArrayTransport
    expect(transport.count).toBe(1)
    expect(transport.messages[0]?.text).toBe('Hi Carol')
  })

  test('default `from` substitution applies to Mailable-built messages too', async () => {
    await app.shutdown()
    app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'main',
          level: 'silent',
          channels: { main: { driver: 'stderr' } },
        },
        mail: { ...arrayMailConfig(), from: 'noreply@acme.com' },
      }),
      new LoggerProvider(),
      new MailProvider(),
    ])
    await app.start({ signalHandlers: false })
    const mail = app.resolve(MailManager)
    await mail.send(WelcomeEmail, { name: 'Dave' })
    const transport = mail.via() as ArrayTransport
    expect(transport.messages[0]?.from).toBe('noreply@acme.com')
  })

  test('throws when called without a Container wired', async () => {
    // Construct MailManager directly (no provider) — container undefined.
    const { LogManager } = await import('@strav/kernel')
    const logManager = new LogManager({
      default: 'main',
      level: 'silent',
      channels: { main: { driver: 'stderr' } },
    })
    const mail = new MailManager(arrayMailConfig(), logManager)
    await expect(mail.send(WelcomeEmail, { name: 'x' })).rejects.toThrow(ConfigError)
    await expect(mail.send(WelcomeEmail, { name: 'x' })).rejects.toThrow(
      /requires a Container.*wire MailProvider/,
    )
    await logManager.shutdown()
  })

  test('cleanup', async () => {
    await app.shutdown()
  })
})
