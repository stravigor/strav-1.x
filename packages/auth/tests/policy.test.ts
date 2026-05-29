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
import { AuthProvider } from '../src/auth_provider.ts'
import type { Authenticatable } from '../src/authenticatable.ts'
import { MemoryGuard } from '../src/memory_guard.ts'
import { AuthorizationError, Gate } from '../src/policy/gate.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Test Models and Policies
// ─────────────────────────────────────────────────────────────────────────────

class Lead {
  constructor(
    public id: string,
    public ownerId: string,
  ) {}
}

class LeadPolicy {
  update(user: Authenticatable, lead: Lead): boolean {
    return lead.ownerId === user.getAuthIdentifier()
  }

  delete(user: Authenticatable, _lead: Lead): boolean {
    return user.getAuthIdentifier() === 'admin'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

interface FakeUser extends Authenticatable {
  id: string
  email: string
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

function makeFakeUser(id: string, email: string): FakeUser {
  return {
    id,
    email,
    getAuthIdentifier: () => id,
    getAuthPassword: () => 'fake-hash',
  }
}

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-auth-policy-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
  MemoryGuard.clearAllSessions()
})

afterEach(() => {
  logDir.cleanup()
})

interface BootOptions {
  seed?: (router: Router, reg: MiddlewareRegistry, repo: FakeUserRepo, gate: Gate) => void
  seedUsers?: FakeUser[]
}

async function bootAuthApp(
  options: BootOptions = {},
): Promise<{ app: Application; repo: FakeUserRepo; gate: Gate }> {
  const repo = new FakeUserRepo()
  for (const user of options.seedUsers ?? []) repo.add(user)

  const app = new Application()
  app.singleton(FakeUserRepo, () => repo)
  app.singleton(
    'memory_guard',
    () => new MemoryGuard({ name: 'memory', userResolver: (id) => repo.byIdSync(id) }),
  )

  const seedProvider = new (class extends ServiceProvider {
    override readonly name = 'test-routes'
    override readonly dependencies = ['http', 'auth']
    override register(app: ApplicationType): void {
      const gate = app.resolve(Gate)
      if (options.seed) {
        options.seed(app.resolve(Router), app.resolve(MiddlewareRegistry), repo, gate)
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
      http: {},
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
  const gate = app.resolve(Gate)
  return { app, repo, gate }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Gate & Policies Unit Tests', () => {
  test('standalone gate abilities', async () => {
    const gate = new Gate()
    gate.define('admin.access', (user) => user.getAuthIdentifier() === 'admin')

    const adminUser = makeFakeUser('admin', 'admin@example.com')
    const normalUser = makeFakeUser('alice', 'alice@example.com')

    expect(await gate.can('admin.access', adminUser)).toBe(true)
    expect(await gate.can('admin.access', normalUser)).toBe(false)
    expect(await gate.cannot('admin.access', normalUser)).toBe(true)

    // authorize throws or passes silently
    await gate.authorize('admin.access', adminUser)
    expect(gate.authorize('admin.access', normalUser)).rejects.toThrow(AuthorizationError)
  })

  test('class-based policies', async () => {
    const gate = new Gate()
    gate.policy(Lead, LeadPolicy)

    const alice = makeFakeUser('alice', 'alice@example.com')
    const bob = makeFakeUser('bob', 'bob@example.com')

    const lead = new Lead('lead-1', 'alice')

    expect(await gate.can('update', alice, lead)).toBe(true)
    expect(await gate.can('update', bob, lead)).toBe(false)
    expect(await gate.cannot('update', bob, lead)).toBe(true)

    await gate.authorize('update', alice, lead)
    expect(gate.authorize('update', bob, lead)).rejects.toThrow(AuthorizationError)
  })

  test('gate throws when ability or policy not defined', async () => {
    const gate = new Gate()
    const user = makeFakeUser('alice', 'alice@example.com')

    expect(await gate.can('unknown', user)).toBe(false)
    expect(gate.authorize('unknown', user)).rejects.toThrow(AuthorizationError)
  })
})

describe('Gate integration with AuthContext & Middleware', () => {
  test('ctx.auth delegates can / cannot / authorize to container-bound Gate', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const { app, gate } = await bootAuthApp({
      seedUsers: [alice],
      seed: (router, _, __, g) => {
        g.define('create-leads', (u) => u.getAuthIdentifier() === 'u-alice')
        router.post('/sign-in', async (ctx) => {
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router.get('/check-perms', async (ctx) => {
          const checkCan = await auth(ctx).can('create-leads')
          const checkCannot = await auth(ctx).cannot('create-leads')
          return ctx.response.ok({ checkCan, checkCannot })
        })
        router.post('/do-authorize', async (ctx) => {
          await auth(ctx).authorize('create-leads')
          return ctx.response.ok({ authorized: true })
        })
      },
    })

    try {
      const kernel = app.resolve(HttpKernel)
      const signIn = await kernel.handle(
        new Request('http://localhost/sign-in', { method: 'POST' }),
      )
      const cookieValue = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

      const resPerms = await kernel.handle(
        new Request('http://localhost/check-perms', { headers: { cookie: cookieValue } }),
      )
      expect(resPerms.status).toBe(200)
      expect(await resPerms.json()).toEqual({ checkCan: true, checkCannot: false })

      const resAuth = await kernel.handle(
        new Request('http://localhost/do-authorize', {
          method: 'POST',
          headers: { cookie: cookieValue },
        }),
      )
      expect(resAuth.status).toBe(200)
      expect(await resAuth.json()).toEqual({ authorized: true })
    } finally {
      await app.shutdown()
    }
  })

  test('policy middleware allows authorized requests, denies unauthorized, and 404s on missing resource', async () => {
    const alice = makeFakeUser('u-alice', 'alice@example.com')
    const bob = makeFakeUser('u-bob', 'bob@example.com')

    const { app } = await bootAuthApp({
      seedUsers: [alice, bob],
      seed: (router, _, __, g) => {
        g.policy(Lead, LeadPolicy)
        g.resource('leads', async (id) => {
          if (id === 'missing') return null
          return new Lead(id, 'u-alice')
        })

        router.post('/sign-in-alice', async (ctx) => {
          await auth(ctx).login(alice)
          return ctx.response.ok({ ok: true })
        })
        router.post('/sign-in-bob', async (ctx) => {
          await auth(ctx).login(bob)
          return ctx.response.ok({ ok: true })
        })

        router
          .get('/leads/:id', (ctx) => ctx.response.ok({ access: 'granted' }))
          .middleware(['auth', 'policy:leads,update'])
      },
    })

    try {
      const kernel = app.resolve(HttpKernel)

      // Sign in Alice
      const signInAlice = await kernel.handle(
        new Request('http://localhost/sign-in-alice', { method: 'POST' }),
      )
      const aliceCookie = signInAlice.headers.get('set-cookie')?.split(';')[0] ?? ''

      // Sign in Bob
      const signInBob = await kernel.handle(
        new Request('http://localhost/sign-in-bob', { method: 'POST' }),
      )
      const bobCookie = signInBob.headers.get('set-cookie')?.split(';')[0] ?? ''

      // Alice owns the lead, should succeed
      const resAlice = await kernel.handle(
        new Request('http://localhost/leads/lead-123', { headers: { cookie: aliceCookie } }),
      )
      expect(resAlice.status).toBe(200)
      expect(await resAlice.json()).toEqual({ access: 'granted' })

      // Bob does not own the lead, should be 403 Forbidden
      const resBob = await kernel.handle(
        new Request('http://localhost/leads/lead-123', {
          headers: { cookie: bobCookie, accept: 'application/json' },
        }),
      )
      expect(resBob.status).toBe(403)

      // Alice accesses missing lead, should be 404 Not Found
      const resMissing = await kernel.handle(
        new Request('http://localhost/leads/missing', { headers: { cookie: aliceCookie } }),
      )
      expect(resMissing.status).toBe(404)
    } finally {
      await app.shutdown()
    }
  })
})
