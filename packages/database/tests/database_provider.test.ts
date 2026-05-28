import { describe, expect, test } from 'bun:test'
import { Application, ConfigError, ConfigProvider } from '@strav/kernel'
import {
  ADMIN_DATABASE_KEY,
  AdminDatabase,
  DATABASE_KEY,
  type Database,
  DatabaseProvider,
  PostgresDatabase,
} from '../src/index.ts'

async function makeApp(databaseConfig: Record<string, unknown> | undefined): Promise<Application> {
  const app = new Application().useProviders([
    new ConfigProvider({ database: databaseConfig }),
    new DatabaseProvider(),
  ])
  await app.start({ signalHandlers: false })
  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary pool binding
// ─────────────────────────────────────────────────────────────────────────────

describe('DatabaseProvider — primary pool', () => {
  test('binds PostgresDatabase + the `database` string key when url is configured', async () => {
    const app = await makeApp({ url: 'postgres://app@localhost:5432/strav' })
    expect(app.has(PostgresDatabase)).toBe(true)
    expect(app.has(DATABASE_KEY)).toBe(true)
    expect(app.resolve(PostgresDatabase)).toBeInstanceOf(PostgresDatabase)
    expect(app.resolve<Database>(DATABASE_KEY)).toBe(app.resolve(PostgresDatabase))
  })

  test('resolving PostgresDatabase throws ConfigError when `config.database.url` is missing', async () => {
    const app = await makeApp({})
    expect(() => app.resolve(PostgresDatabase)).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Admin pool binding — opt-in via config.database.admin
// ─────────────────────────────────────────────────────────────────────────────

describe('DatabaseProvider — admin pool', () => {
  test('binds AdminDatabase + the `database.admin` string key when admin is configured', async () => {
    const app = await makeApp({
      url: 'postgres://app@localhost:5432/strav',
      admin: { url: 'postgres://admin@localhost:5432/strav' },
    })
    expect(app.has(AdminDatabase)).toBe(true)
    expect(app.has(ADMIN_DATABASE_KEY)).toBe(true)
    expect(app.resolve(AdminDatabase)).toBeInstanceOf(AdminDatabase)
    expect(app.resolve<Database>(ADMIN_DATABASE_KEY)).toBe(app.resolve(AdminDatabase))
  })

  test('does NOT bind AdminDatabase when admin is not configured', async () => {
    const app = await makeApp({ url: 'postgres://app@localhost:5432/strav' })
    expect(app.has(AdminDatabase)).toBe(false)
    expect(app.has(ADMIN_DATABASE_KEY)).toBe(false)
  })

  test('AdminDatabase is a distinct instance from PostgresDatabase', async () => {
    const app = await makeApp({
      url: 'postgres://app@localhost:5432/strav',
      admin: { url: 'postgres://admin@localhost:5432/strav' },
    })
    expect(app.resolve(AdminDatabase)).not.toBe(app.resolve(PostgresDatabase))
  })

  test('respects per-pool idleTimeout / max settings', async () => {
    // Sanity check that the admin config slice is wired through; we don't
    // have a way to inspect the pool's connection options post-construction
    // without opening a real connection, so the assertion is just
    // "construction succeeded with the extra fields."
    const app = await makeApp({
      url: 'postgres://app@localhost:5432/strav',
      max: 20,
      admin: {
        url: 'postgres://admin@localhost:5432/strav',
        max: 4,
        idleTimeout: 30,
      },
    })
    expect(app.resolve(AdminDatabase)).toBeInstanceOf(AdminDatabase)
  })
})
