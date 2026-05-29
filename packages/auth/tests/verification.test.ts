import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpKernel, HttpProvider, MiddlewareRegistry, Router } from '@strav/http'
import { Application, ConfigProvider, LoggerProvider, ServiceProvider } from '@strav/kernel'
import { assertAuth as auth } from '../src/assert_auth.ts'
import { AuthProvider } from '../src/auth_provider.ts'
import type { Authenticatable } from '../src/authenticatable.ts'
import { MemoryGuard } from '../src/memory_guard.ts'
import {
  EmailVerification,
  EmailVerificationError,
} from '../src/verification/email_verification.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

interface FakeUser extends Authenticatable {
  id: string
  email: string
  email_verified_at: Date | null
}

class FakeUserRepo {
  private readonly byId = new Map<string, FakeUser>()

  add(user: FakeUser): FakeUser {
    this.byId.set(user.id, user)
    return user
  }

  byIdSync(id: string): FakeUser | null {
    return this.byId.get(id) ?? null
  }
}

function makeFakeUser(id: string, email: string, verified = true): FakeUser {
  return {
    id,
    email,
    email_verified_at: verified ? new Date() : null,
    getAuthIdentifier: () => id,
    getAuthPassword: () => 'fake-hash',
  }
}

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-auth-verification-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
  MemoryGuard.clearAllSessions()
})

afterEach(() => {
  logDir.cleanup()
})

interface BootOptions {
  seed?: (router: Router, reg: MiddlewareRegistry, repo: FakeUserRepo) => void
  seedUsers?: FakeUser[]
}

async function bootAuthApp(
  options: BootOptions = {},
): Promise<{ app: Application; repo: FakeUserRepo }> {
  const repo = new FakeUserRepo()
  for (const user of options.seedUsers ?? []) repo.add(user)

  const app = new Application()
  app.singleton(FakeUserRepo, () => repo)
  app.singleton(
    'memory_guard',
    () => new MemoryGuard({ name: 'memory', userResolver: (id) => repo.byIdSync(id) }),
  )

  app.useProviders([
    new ConfigProvider({
      logger: {
        default: 'file',
        level: 'error',
        channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
      },
      app: {
        url: 'https://myapp.com',
        key: 'test-app-key-12345678901234567890',
      },
      auth: {
        default: 'memory',
        guards: { memory: { driver: 'custom', service: 'memory_guard' } },
        verification: {
          path: '/auth/verify-email',
          ttlSeconds: 3600,
        },
      },
    }),
    new LoggerProvider(),
    new HttpProvider(),
    new AuthProvider(),
    new (class extends ServiceProvider {
      override readonly name = 'test-routes'
      override readonly dependencies = ['http', 'auth']
      override register(app: Application): void {
        if (options.seed) {
          options.seed(app.resolve(Router), app.resolve(MiddlewareRegistry), repo)
        }
      }
    })(),
  ])

  await app.start({ signalHandlers: false })
  return { app, repo }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('EmailVerification', () => {
  const appKey = 'some-secret-key-that-is-long-enough'

  test('signedUrl generates structured verification link', () => {
    const ev = new EmailVerification({ appKey, baseUrl: 'https://example.com' })
    const url = ev.signedUrl('user-1')

    expect(url).toMatch(/^https:\/\/example.com\/auth\/verify\/user-1\.\d+\.[a-f0-9]{64}$/)
  })

  test('verify extracts correct userId from valid token', () => {
    const ev = new EmailVerification({ appKey, baseUrl: 'https://example.com' })
    const url = ev.signedUrl('user-2')
    const token = decodeURIComponent(url.split('/').pop()!)

    const result = ev.verify(token)
    expect(result).toEqual({ userId: 'user-2' })
  })

  test('verify throws on expired token', () => {
    const ev = new EmailVerification({ appKey, baseUrl: 'https://example.com', ttlSeconds: 10 })
    const now = Math.floor(Date.now() / 1000)

    const url = ev.signedUrl('user-3', { now: now - 20 })
    const token = decodeURIComponent(url.split('/').pop()!)

    expect(() => ev.verify(token, { now })).toThrow(EmailVerificationError)
    try {
      ev.verify(token, { now })
    } catch (err: any) {
      expect(err.context?.code).toBe('expired')
    }
  })

  test('verify throws on tampered token signature', () => {
    const ev = new EmailVerification({ appKey, baseUrl: 'https://example.com' })
    const url = ev.signedUrl('user-4')
    const parts = decodeURIComponent(url.split('/').pop()!).split('.')

    // Tamper the signature part
    parts[2] = `a${parts[2]?.slice(1)}`
    const tampered = parts.join('.')

    expect(() => ev.verify(tampered)).toThrow(EmailVerificationError)
  })

  test('verify throws on malformed token structure', () => {
    const ev = new EmailVerification({ appKey })
    expect(() => ev.verify('malformed')).toThrow(EmailVerificationError)
    expect(() => ev.verify('a.b')).toThrow(EmailVerificationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Middleware & Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('EmailVerification Middleware Integration', () => {
  test('verified middleware blocks unverified users, allows verified', async () => {
    const verifiedUser = makeFakeUser('u-verified', 'ver@example.com', true)
    const unverifiedUser = makeFakeUser('u-unverified', 'unver@example.com', false)

    const { app } = await bootAuthApp({
      seedUsers: [verifiedUser, unverifiedUser],
      seed: (router) => {
        router.post('/login-verified', async (ctx) => {
          await auth(ctx).login(verifiedUser)
          return ctx.response.ok({ ok: true })
        })
        router.post('/login-unverified', async (ctx) => {
          await auth(ctx).login(unverifiedUser)
          return ctx.response.ok({ ok: true })
        })
        router
          .get('/protected', (ctx) => ctx.response.ok({ sensitive: 'data' }))
          .middleware(['auth', 'verified'])
      },
    })

    try {
      const kernel = app.resolve(HttpKernel)

      // Verified user access
      const loginVer = await kernel.handle(
        new Request('http://localhost/login-verified', { method: 'POST' }),
      )
      const cookieVer = loginVer.headers.get('set-cookie')?.split(';')[0] ?? ''

      const resVer = await kernel.handle(
        new Request('http://localhost/protected', { headers: { cookie: cookieVer } }),
      )
      expect(resVer.status).toBe(200)
      expect(await resVer.json()).toEqual({ sensitive: 'data' })

      // Unverified user access (should get 403)
      const loginUnver = await kernel.handle(
        new Request('http://localhost/login-unverified', { method: 'POST' }),
      )
      const cookieUnver = loginUnver.headers.get('set-cookie')?.split(';')[0] ?? ''

      const resUnver = await kernel.handle(
        new Request('http://localhost/protected', {
          headers: { cookie: cookieUnver, accept: 'application/json' },
        }),
      )
      expect(resUnver.status).toBe(403)
      const body = (await resUnver.json()) as any
      expect(body.error.code).toBe('auth.email-not-verified')
    } finally {
      await app.shutdown()
    }
  })

  test('wires EmailVerification from container config', async () => {
    const { app } = await bootAuthApp()
    try {
      const ev = app.resolve(EmailVerification)
      expect(ev).toBeInstanceOf(EmailVerification)

      const url = ev.signedUrl('user-100')
      expect(url).toMatch(/^https:\/\/myapp.com\/auth\/verify-email\/user-100\.\d+\.[a-f0-9]{64}$/)
    } finally {
      await app.shutdown()
    }
  })
})
