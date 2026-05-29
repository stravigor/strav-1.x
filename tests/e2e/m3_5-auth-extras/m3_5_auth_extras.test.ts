/**
 * Auth-extras end-to-end smoke — proves the magic-link / email-verification
 * / policy stack wires through `AuthProvider` and round-trips against a
 * real Postgres.
 *
 * The wire under test:
 *
 *   AuthProvider.register()
 *      → app.singleton(MagicLinkManager, factory using config.auth.magic + PostgresDatabase)
 *      → app.singleton(EmailVerification, factory using config.app.key)
 *      → app.singleton(Gate)
 *      → MiddlewareRegistry registers 'policy' (factory) + 'verified'
 *
 *   MagicLinkManager.create  → INSERT into strav_magic_links
 *   MagicLinkManager.consume → SELECT + UPDATE used_at
 *   EmailVerification.signedUrl / verify  (stateless HMAC, no DB)
 *   Gate.authorize / can     (in-memory registry)
 *
 * Self-skips when no Postgres is available — matches the other e2e
 * suites' contract. CI brings up Postgres; local dev does
 * `docker-compose up`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  AuthorizationError,
  AuthProvider,
  EmailVerification,
  type EmailVerificationError,
  Gate,
  MagicLinkError,
  MagicLinkManager,
  magicLinkSchema,
} from '@strav/auth'
import { emitCreateTable, type PostgresDatabase, SchemaRegistry } from '@strav/database'
import { HttpProvider, MiddlewareRegistry } from '@strav/http'
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../../support/postgres_test_db.ts'

const PG_AVAILABLE = await isPostgresAvailable()

const APP_KEY = '0123456789abcdef0123456789abcdef'
const APP_URL = 'https://app.test'

// ─── Fixtures ───────────────────────────────────────────────────────────────

class TestUser {
  constructor(
    readonly id: string,
    readonly role: 'admin' | 'user',
  ) {}
  getAuthIdentifier() {
    return this.id
  }
  getAuthPassword() {
    return ''
  }
}

class Lead {
  constructor(
    readonly id: string,
    readonly owner_id: string,
  ) {}
}

class LeadPolicy {
  update(user: TestUser, lead: Lead) {
    return lead.owner_id === user.id || user.role === 'admin'
  }
}

describe.skipIf(!PG_AVAILABLE)('auth-extras e2e: magic / verification / policy', () => {
  let app: Application
  let setupDb: PostgresDatabase
  let magic: MagicLinkManager
  let ev: EmailVerification
  let gate: Gate

  beforeAll(async () => {
    // Pre-migrate strav_magic_links on a separate connection so the
    // MagicLinkManager (using the app's pool) sees a ready table.
    setupDb = createTestDatabase()
    await resetSchema(setupDb)
    const registry = new SchemaRegistry().registerAll([magicLinkSchema])
    await setupDb.execute(emitCreateTable(magicLinkSchema, { registry }).sql)

    const { DatabaseProvider } = await import('@strav/database')

    app = new Application()
    app.useProviders([
      new ConfigProvider({
        app: { key: APP_KEY, url: APP_URL },
        logger: {
          default: 'main',
          level: 'silent',
          channels: { main: { driver: 'stderr' } },
        },
        database: {
          url: `postgres://${process.env.DB_USER}:${encodeURIComponent(
            process.env.DB_PASSWORD as string,
          )}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
        },
        http: { middleware: [] },
        auth: {
          default: 'memory',
          guards: { memory: { driver: 'custom', service: 'memory_guard' } },
        },
      }),
      new LoggerProvider(),
      new DatabaseProvider(),
      new HttpProvider(),
      new AuthProvider(),
    ])

    // AuthProvider validates guard config at boot — bind a no-op guard
    // factory so the memory guard resolves without touching the DB.
    app.singleton('memory_guard', () => ({
      name: 'memory',
      authenticate: async () => null,
      login: async () => {},
      logout: async () => {},
    }))

    await app.start({ signalHandlers: false })

    magic = app.resolve(MagicLinkManager)
    ev = app.resolve(EmailVerification)
    gate = app.resolve(Gate)
  })

  afterAll(async () => {
    await app?.shutdown()
    await setupDb?.close({ timeout: 2 })
  })

  // ─── Magic links ──────────────────────────────────────────────────────────

  test('MagicLinkManager.create returns a well-formed URL backed by a DB row', async () => {
    const url = await magic.create('user-1', { ttl: '15m', redirectTo: '/dashboard' })
    expect(url).toMatch(/^https:\/\/app\.test\/auth\/magic\/[0-9a-f]{64}$/)

    const token = url.split('/').pop()!
    const row = await setupDb.queryOne<{ token: string; redirect_to: string; used_at: Date | null }>(
      `SELECT token, redirect_to, used_at FROM "strav_magic_links" WHERE token = $1`,
      [token],
    )
    expect(row?.token).toBe(token)
    expect(row?.redirect_to).toBe('/dashboard')
    expect(row?.used_at).toBeNull()
  })

  test('consume fills used_at and returns the row payload', async () => {
    const url = await magic.create('user-2', { ttl: '15m', redirectTo: '/welcome' })
    const token = url.split('/').pop()!

    const result = await magic.consume(token)
    expect(result).toEqual({ userId: 'user-2', redirectTo: '/welcome' })

    const row = await setupDb.queryOne<{ used_at: Date | null }>(
      `SELECT used_at FROM "strav_magic_links" WHERE token = $1`,
      [token],
    )
    expect(row?.used_at).toBeInstanceOf(Date)
  })

  test('second consume of the same token rejects with code "used"', async () => {
    const url = await magic.create('user-3')
    const token = url.split('/').pop()!
    await magic.consume(token)

    try {
      await magic.consume(token)
      throw new Error('expected MagicLinkError')
    } catch (err) {
      expect(err).toBeInstanceOf(MagicLinkError)
      expect((err as MagicLinkError).context).toEqual({ code: 'used' })
    }
  })

  test('unknown token rejects with code "invalid"', async () => {
    try {
      await magic.consume('00'.repeat(32))
      throw new Error('expected MagicLinkError')
    } catch (err) {
      expect(err).toBeInstanceOf(MagicLinkError)
      expect((err as MagicLinkError).context).toEqual({ code: 'invalid' })
    }
  })

  // ─── Email verification ──────────────────────────────────────────────────

  test('EmailVerification.signedUrl → verify round-trips', () => {
    const url = ev.signedUrl('user-42')
    const token = decodeURIComponent(url.split('/').pop()!)
    const { userId } = ev.verify(token)
    expect(userId).toBe('user-42')
    expect(url.startsWith(`${APP_URL}/auth/verify/`)).toBe(true)
  })

  test('expired verification token rejects', () => {
    // Stamp it 25h ago — past the default 24h TTL.
    const oldNow = Math.floor(Date.now() / 1000) - 25 * 3600
    const url = ev.signedUrl('user-43', { now: oldNow })
    const token = decodeURIComponent(url.split('/').pop()!)
    try {
      ev.verify(token)
      throw new Error('expected EmailVerificationError')
    } catch (err) {
      expect((err as EmailVerificationError).context).toEqual({ code: 'expired' })
    }
  })

  test('tampered signature rejects with code "invalid"', () => {
    const url = ev.signedUrl('user-44')
    const token = decodeURIComponent(url.split('/').pop()!)
    const tampered = token.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
    try {
      ev.verify(tampered)
      throw new Error('expected EmailVerificationError')
    } catch (err) {
      expect((err as EmailVerificationError).context).toEqual({ code: 'invalid' })
    }
  })

  // ─── Gate / policies ─────────────────────────────────────────────────────

  test('Gate routes policy lookup by resource constructor', async () => {
    gate.policy(Lead, LeadPolicy)
    const alice = new TestUser('u1', 'user')
    const aliceLead = new Lead('lead-1', 'u1')
    const bobLead = new Lead('lead-2', 'u2')

    expect(await gate.can('update', alice, aliceLead)).toBe(true)
    expect(await gate.can('update', alice, bobLead)).toBe(false)
    await expect(gate.authorize('update', alice, bobLead)).rejects.toBeInstanceOf(
      AuthorizationError,
    )
  })

  test('Gate ability functions resolve when no resource is passed', async () => {
    gate.define('admin.access', (user) => (user as TestUser).role === 'admin')
    expect(await gate.can('admin.access', new TestUser('u-admin', 'admin'))).toBe(true)
    expect(await gate.can('admin.access', new TestUser('u-user', 'user'))).toBe(false)
  })

  test('AuthProvider registered the policy + verified middleware', () => {
    const reg = app.resolve(MiddlewareRegistry)
    expect(reg.has('policy')).toBe(true)
    expect(reg.has('verified')).toBe(true)
  })
})
