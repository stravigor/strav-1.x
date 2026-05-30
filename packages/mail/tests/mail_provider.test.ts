import { describe, expect, test } from 'bun:test'
import { Application, ConfigError, ConfigProvider, LoggerProvider } from '@strav/kernel'
import { type ArrayTransport, MailManager, MailProvider } from '../src/index.ts'

function makeApp(mailConfig: unknown): Application {
  const app = new Application()
  app.useProviders([
    new ConfigProvider({
      logger: {
        default: 'main',
        level: 'silent',
        channels: { main: { driver: 'stderr' } },
      },
      ...(mailConfig === undefined ? {} : { mail: mailConfig }),
    }),
    new LoggerProvider(),
    new MailProvider(),
  ])
  return app
}

describe('MailProvider', () => {
  test('binds MailManager + the "mail" alias after boot', async () => {
    const app = makeApp({
      default: 'array',
      transports: { array: { driver: 'array' } },
    })
    await app.start({ signalHandlers: false })
    try {
      const m = app.resolve(MailManager)
      const alias = app.resolve<MailManager>('mail')
      expect(alias).toBe(m)
      await m.send({ to: 'a@x', subject: 's', text: 't' })
      const transport = m.via() as ArrayTransport
      expect(transport.count).toBe(1)
    } finally {
      await app.shutdown()
    }
  })

  test('throws ConfigError at boot when config.mail is missing', async () => {
    const app = makeApp(undefined)
    await expect(app.start({ signalHandlers: false })).rejects.toThrow(ConfigError)
  })

  test('throws ConfigError at boot when default transport is undefined', async () => {
    const app = makeApp({
      default: 'missing',
      transports: { array: { driver: 'array' } },
    })
    await expect(app.start({ signalHandlers: false })).rejects.toThrow(
      /default transport "missing" is not defined/,
    )
  })

  test('shutdown() closes cached transports without throwing', async () => {
    const app = makeApp({
      default: 'array',
      transports: { array: { driver: 'array' } },
    })
    await app.start({ signalHandlers: false })
    // Eager via() to populate the cache.
    app.resolve(MailManager).via()
    await expect(app.shutdown()).resolves.toBeUndefined()
  })
})
