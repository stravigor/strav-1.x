import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpKernel, HttpProvider, MiddlewareRegistry, Router } from '@strav/http'
import {
  Application,
  type Application as ApplicationType,
  ConfigProvider,
  LoggerProvider,
  ServiceProvider,
} from '@strav/kernel'
import { assertAuth as auth } from '../src/assert_auth.ts'
import { AuthManager } from '../src/auth_manager.ts'
import { AuthProvider } from '../src/auth_provider.ts'
import type { Authenticatable } from '../src/authenticatable.ts'
import { MemoryGuard } from '../src/memory_guard.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

interface FakeUser extends Authenticatable {
  id: string
  email: string
  passwordHash: string
}

class FakeUserRepo {
  private readonly byId = new Map<string, FakeUser>()
  private readonly byEmail = new Map<string, string>()

  add(user: FakeUser): FakeUser {
    this.byId.set(user.id, user)
    this.byEmail.set(user.email, user.id)
    return user
  }

  byIdSync(id: string): FakeUser | null {
    return this.byId.get(id) ?? null
  }

  byEmailSync(email: string): FakeUser | null {
    const id = this.byEmail.get(email)
    return id ? this.byIdSync(id) : null
  }
}

function makeFakeUser(id: string, email: string): FakeUser {
  return {
    id,
    email,
    passwordHash: 'fake-hash',
    getAuthIdentifier: () => id,
    getAuthPassword: () => 'fake-hash',
  }
}

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-auth-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
  MemoryGuard.clearAllSessions()
})
afterEach(() => {
  logDir.cleanup()
})

interface BootOptions {
  seed?: (router: Router, reg: MiddlewareRegistry, repo: FakeUserRepo) => void
  seedUsers?: FakeUser[]
  httpConfig?: Record<string, unknown>
}

async function bootAuthApp(
  options: BootOptions = {},
): Promise<{ app: Application; repo: FakeUserRepo }> {
  const repo = new FakeUserRepo()
  for (const user of options.seedUsers ?? []) repo.add(user)

  const app = new Application()
  app.singleton(FakeUserRepo, () => repo)
  // Bind the guard under a string key so AuthProvider can pull it via the
  // `{ driver: 'custom', service: '...' }` config entry.
  app.singleton(
    'memory_guard',
    () => new MemoryGuard({ name: 'memory', userResolver: (id) => repo.byIdSync(id) }),
  )

  const seedProvider = new (class extends ServiceProvider {
    override readonly name = 'test-routes'
    override readonly dependencies = ['http', 'auth']
    override register(app: ApplicationType): void {
      if (options.seed) {
        options.seed(app.resolve(Router), app.resolve(MiddlewareRegistry), repo)
      }
    }
  })()

  app.useProviders([
    new ConfigProvider({
      logger: {
        default: 'file',
        level: 'error',
        channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
      },
      http: options.httpConfig ?? {},
      auth: {
        default: 'memory',
        guards: { memory: { driver: 'custom', service: 'memory_guard' } },
      },
    }),
    new LoggerProvider(),
    new HttpProvider(),
    new AuthProvider(),
    seedProvider,
  ])

  await app.start({ signalHandlers: false })
  return { app, repo }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthProvider — wiring', () => {
  test('binds AuthManager from config.auth.guards', async () => {
    const { app } = await bootAuthApp()
    try {
      const manager = app.resolve(AuthManager)
      expect(manager.default).toBe('memory')
      expect(manager.list().map((g) => g.name)).toEqual(['memory'])
    } finally {
      await app.shutdown()
    }
  })

  test('throws ConfigError at boot when config.auth is missing', async () => {
    const app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'error',
          channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
        },
      }),
      new LoggerProvider(),
      new HttpProvider(),
      new AuthProvider(),
    ])
    await expect(app.start({ signalHandlers: false })).rejects.toThrow(/config\.auth/)
  })

  test('throws ConfigError when default guard is not declared in config.auth.guards', async () => {
    const repo = new FakeUserRepo()
    const app = new Application()
    app.singleton(
      'memory_guard',
      () =>
        new MemoryGuard({
          name: 'memory',
          userResolver: (id) => repo.byIdSync(id),
        }),
    )
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'error',
          channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
        },
        auth: {
          default: 'web',
          guards: { memory: { driver: 'custom', service: 'memory_guard' } },
        },
      }),
      new LoggerProvider(),
      new HttpProvider(),
      new AuthProvider(),
    ])
    await expect(app.start({ signalHandlers: false })).rejects.toThrow(/default guard "web"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ctx.auth + login/logout
// ─────────────────────────────────────────────────────────────────────────────

describe('ctx.auth flow', () => {
  test('ctx.auth is populated on every request', async () => {
    const { app } = await bootAuthApp({
      seed: (router) => {
        router.get('/whoami', async (ctx) => {
          const present = !!ctx.auth
          const user = await ctx.auth?.user
          return ctx.response.ok({ present, user })
        })
      },
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/whoami'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { present: boolean; user: unknown }
      expect(body.present).toBe(true)
      expect(body.user).toBeNull()
    } finally {
      await app.shutdown()
    }
  })

  test('login + subsequent request: user is recovered from cookie', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const { app } = await bootAuthApp({
      seedUsers: [alice],
      seed: (router) => {
        router.post('/sign-in', async (ctx) => {
          // Pretend we authenticated; just call login()
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router.get('/me', async (ctx) => {
          const user = await auth(ctx).userOrFail()
          return ctx.response.ok({ id: user.getAuthIdentifier() })
        })
      },
    })
    try {
      const kernel = app.resolve(HttpKernel)
      const signIn = await kernel.handle(
        new Request('http://localhost/sign-in', { method: 'POST' }),
      )
      const cookie = signIn.headers.get('set-cookie')
      expect(cookie).toContain('strav_memory_session=')

      // Extract the cookie name=value pair for the next request.
      const cookieValue = cookie?.split(';')[0] ?? ''
      const me = await kernel.handle(
        new Request('http://localhost/me', { headers: { cookie: cookieValue } }),
      )
      expect(me.status).toBe(200)
      expect(await me.json()).toEqual({ id: 'u-alice' })
    } finally {
      await app.shutdown()
    }
  })

  test('logout clears the session and forgets the cookie', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const { app } = await bootAuthApp({
      seedUsers: [alice],
      seed: (router) => {
        router.post('/sign-in', async (ctx) => {
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router.post('/sign-out', async (ctx) => {
          await auth(ctx).logout()
          return ctx.response.ok({ ok: true })
        })
        router.get('/me', async (ctx) => {
          return ctx.response.ok({ user: auth(ctx).user })
        })
      },
    })
    try {
      const kernel = app.resolve(HttpKernel)
      const signIn = await kernel.handle(
        new Request('http://localhost/sign-in', { method: 'POST' }),
      )
      const cookieValue = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

      await kernel.handle(
        new Request('http://localhost/sign-out', {
          method: 'POST',
          headers: { cookie: cookieValue },
        }),
      )

      // After logout, the original cookie no longer resolves a user.
      const me = await kernel.handle(
        new Request('http://localhost/me', { headers: { cookie: cookieValue } }),
      )
      expect(me.status).toBe(200)
      const body = (await me.json()) as { user: unknown }
      expect(body.user).toBeNull()
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// auth middleware
// ─────────────────────────────────────────────────────────────────────────────

describe('auth middleware', () => {
  test('blocks unauthenticated requests with 401', async () => {
    const { app } = await bootAuthApp({
      seed: (router) => {
        router.get('/dashboard', (ctx) => ctx.response.ok({ ok: true })).middleware('auth')
      },
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(
          new Request('http://localhost/dashboard', { headers: { accept: 'application/json' } }),
        )
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('auth.not-authenticated')
    } finally {
      await app.shutdown()
    }
  })

  test('allows authenticated requests through', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const { app } = await bootAuthApp({
      seedUsers: [alice],
      seed: (router) => {
        router.post('/sign-in', async (ctx) => {
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router
          .get('/dashboard', async (ctx) => {
            return ctx.response.ok({ id: (await auth(ctx).userOrFail()).getAuthIdentifier() })
          })
          .middleware('auth')
      },
    })
    try {
      const kernel = app.resolve(HttpKernel)
      const signIn = await kernel.handle(
        new Request('http://localhost/sign-in', { method: 'POST' }),
      )
      const cookieValue = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

      const dash = await kernel.handle(
        new Request('http://localhost/dashboard', { headers: { cookie: cookieValue } }),
      )
      expect(dash.status).toBe(200)
      expect(await dash.json()).toEqual({ id: 'u-alice' })
    } finally {
      await app.shutdown()
    }
  })

  test('guest middleware blocks signed-in requests with 403', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const { app } = await bootAuthApp({
      seedUsers: [alice],
      seed: (router) => {
        router.post('/sign-in', async (ctx) => {
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router.get('/login', (ctx) => ctx.response.ok({ form: true })).middleware('guest')
      },
    })
    try {
      const kernel = app.resolve(HttpKernel)

      // Anonymous → reaches the route.
      const anon = await kernel.handle(new Request('http://localhost/login'))
      expect(anon.status).toBe(200)

      const signIn = await kernel.handle(
        new Request('http://localhost/sign-in', { method: 'POST' }),
      )
      const cookieValue = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

      // Authenticated → blocked.
      const blocked = await kernel.handle(
        new Request('http://localhost/login', {
          headers: { cookie: cookieValue, accept: 'application/json' },
        }),
      )
      expect(blocked.status).toBe(403)
      const body = (await blocked.json()) as { error: { code: string } }
      expect(body.error.code).toBe('auth.already-authenticated')
    } finally {
      await app.shutdown()
    }
  })

  test('factory form: `auth:memory` resolves the named guard', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const { app } = await bootAuthApp({
      seedUsers: [alice],
      seed: (router) => {
        router.post('/sign-in', async (ctx) => {
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router
          .get('/m', async (ctx) => {
            const user = await auth(ctx).userOrFail()
            return ctx.response.ok({ id: user.getAuthIdentifier() })
          })
          .middleware('auth:memory')
      },
    })
    try {
      const kernel = app.resolve(HttpKernel)
      const signIn = await kernel.handle(
        new Request('http://localhost/sign-in', { method: 'POST' }),
      )
      const cookieValue = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

      const res = await kernel.handle(
        new Request('http://localhost/m', { headers: { cookie: cookieValue } }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: 'u-alice' })
    } finally {
      await app.shutdown()
    }
  })
})
