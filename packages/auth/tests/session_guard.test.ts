import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseExecutor, PostgresDatabase } from '@strav/database'
import { HttpProvider } from '@strav/http'
import { Application, ConfigProvider, EventBus, LoggerProvider } from '@strav/kernel'
import { AuthProvider } from '../src/auth_provider.ts'
import type { Authenticatable } from '../src/authenticatable.ts'
import { Session } from '../src/session/session.ts'
import { SessionGuard } from '../src/session/session_guard.ts'
import { SessionRepository } from '../src/session/session_repository.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Test-only helper: assert a value is defined and return it. Replaces `!`. */
function nonNull<T>(value: T | null | undefined, message = 'expected non-null value'): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

interface FakeUser extends Authenticatable {
  id: string
  email: string
}

function makeUser(id: string, email = 'a@b.com'): FakeUser {
  return {
    id,
    email,
    getAuthIdentifier: () => id,
    getAuthPassword: () => 'hash',
  }
}

/** Builds a Session instance the way the Repository would hydrate one. */
function makeSession(id: string, userId: string, expiresAt: Date): Session {
  const s = new Session()
  s.id = id
  s.user_id = userId
  s.expires_at = expiresAt
  s.created_at = new Date()
  s.updated_at = new Date()
  return s
}

interface FakeCtx {
  request: { cookies: Record<string, string> }
  response: {
    cookie: (name: string, value: string, opts: Record<string, unknown>) => void
    forgetCookie: (name: string, opts: Record<string, unknown>) => void
    setCookies: Map<string, { value: string; opts: Record<string, unknown> }>
    forgotten: string[]
  }
}

function makeCtx(cookies: Record<string, string> = {}): FakeCtx {
  const setCookies = new Map<string, { value: string; opts: Record<string, unknown> }>()
  const forgotten: string[] = []
  return {
    request: { cookies },
    response: {
      cookie: (name, value, opts) => setCookies.set(name, { value, opts }),
      forgetCookie: (name) => forgotten.push(name),
      setCookies,
      forgotten,
    },
  }
}

/** Stub SessionRepository — records calls, returns scripted results. */
function stubSessionRepo(scripted: { findValid?: Session | null; find?: Session | null } = {}) {
  const calls = {
    findValid: [] as string[],
    create: [] as Partial<Session>[],
    find: [] as string[],
    delete: [] as string[],
  }
  const stub = {
    async findValid(id: string) {
      calls.findValid.push(id)
      return scripted.findValid ?? null
    },
    async create(attrs: Partial<Session>) {
      calls.create.push(attrs)
      return attrs as Session
    },
    async find(id: string) {
      calls.find.push(id)
      return scripted.find ?? null
    },
    async delete(session: Session) {
      calls.delete.push(session.id)
    },
  }
  return { stub: stub as unknown as SessionRepository, calls }
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionGuard — authenticate / login / logout
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionGuard.authenticate', () => {
  test('returns null when no cookie is present', async () => {
    const { stub } = stubSessionRepo()
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx() as never)
    expect(result).toBeNull()
  })

  test('returns null when the cookie value is not a valid session', async () => {
    const { stub, calls } = stubSessionRepo({ findValid: null })
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx({ strav_session: 'stale' }) as never)
    expect(result).toBeNull()
    expect(calls.findValid).toEqual(['stale'])
  })

  test('resolves the user via userResolver when the session is valid', async () => {
    const session = makeSession('sess-1', 'user-1', new Date(Date.now() + 60_000))
    const { stub } = stubSessionRepo({ findValid: session })
    const user = makeUser('user-1')
    const guard = new SessionGuard({
      sessions: stub,
      userResolver: (id) => (id === 'user-1' ? user : null),
    })
    const result = await guard.authenticate(makeCtx({ strav_session: 'sess-1' }) as never)
    expect(result).toBe(user as never)
  })

  test('returns null when resolver returns null for a known session (user was deleted)', async () => {
    const session = makeSession('sess-2', 'user-deleted', new Date(Date.now() + 60_000))
    const { stub } = stubSessionRepo({ findValid: session })
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx({ strav_session: 'sess-2' }) as never)
    expect(result).toBeNull()
  })

  test('honors a custom cookie name', async () => {
    const { stub, calls } = stubSessionRepo()
    const guard = new SessionGuard({
      sessions: stub,
      userResolver: () => null,
      cookieName: 'app_sid',
    })
    await guard.authenticate(makeCtx({ app_sid: 'X' }) as never)
    expect(calls.findValid).toEqual(['X'])
  })
})

describe('SessionGuard.login', () => {
  test('creates a session row with a ULID + future expires_at, sets cookie', async () => {
    const { stub, calls } = stubSessionRepo()
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const ctx = makeCtx()
    const before = Date.now()
    await guard.login(ctx as never, makeUser('user-7'))
    const after = Date.now()

    expect(calls.create).toHaveLength(1)
    const created = nonNull(calls.create[0])
    expect(typeof created.id).toBe('string')
    expect((created.id as string).length).toBe(26)
    expect(created.user_id).toBe('user-7')
    const expiresMs = (created.expires_at as Date).getTime()
    expect(expiresMs).toBeGreaterThan(before)
    // Default TTL = 14 days; sanity-check it landed somewhere in the future.
    expect(expiresMs).toBeLessThanOrEqual(after + 1000 * 60 * 60 * 24 * 14 + 10)

    const cookie = nonNull(ctx.response.setCookies.get('strav_session'))
    expect(cookie.value).toBe(created.id as string)
    expect(cookie.opts.httpOnly).toBe(true)
    expect(cookie.opts.sameSite).toBe('lax')
    expect(cookie.opts.secure).toBe(true)
    expect(cookie.opts.path).toBe('/')
  })

  test('honors ttlSeconds + cookieName + secure overrides', async () => {
    const { stub, calls } = stubSessionRepo()
    const guard = new SessionGuard({
      sessions: stub,
      userResolver: () => null,
      ttlSeconds: 60,
      cookieName: 'app_sid',
      secure: false,
    })
    const ctx = makeCtx()
    const before = Date.now()
    await guard.login(ctx as never, makeUser('user-9'))
    const expiresMs = (nonNull(calls.create[0]).expires_at as Date).getTime()
    expect(expiresMs).toBeLessThanOrEqual(before + 60_000 + 10)
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60_000 - 50)
    const overrideCookie = nonNull(ctx.response.setCookies.get('app_sid'))
    expect(overrideCookie.opts.secure).toBe(false)
  })
})

describe('SessionGuard.logout', () => {
  test('deletes the session row and clears the cookie when one was present', async () => {
    const session = makeSession('sess-z', 'user-z', new Date(Date.now() + 60_000))
    const { stub, calls } = stubSessionRepo({ find: session })
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const ctx = makeCtx({ strav_session: 'sess-z' })
    await guard.logout(ctx as never)
    expect(calls.find).toEqual(['sess-z'])
    expect(calls.delete).toEqual(['sess-z'])
    expect(ctx.response.forgotten).toEqual(['strav_session'])
  })

  test('clears the cookie even when the session row is already gone', async () => {
    const { stub, calls } = stubSessionRepo({ find: null })
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const ctx = makeCtx({ strav_session: 'sess-gone' })
    await guard.logout(ctx as never)
    expect(calls.find).toEqual(['sess-gone'])
    expect(calls.delete).toEqual([])
    expect(ctx.response.forgotten).toEqual(['strav_session'])
  })

  test('no-op (just clears cookie) when no cookie was present', async () => {
    const { stub, calls } = stubSessionRepo()
    const guard = new SessionGuard({ sessions: stub, userResolver: () => null })
    const ctx = makeCtx()
    await guard.logout(ctx as never)
    expect(calls.find).toEqual([])
    expect(calls.delete).toEqual([])
    expect(ctx.response.forgotten).toEqual(['strav_session'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Session.isValid (Model helper)
// ─────────────────────────────────────────────────────────────────────────────

describe('Session.isValid', () => {
  test('true when expires_at is in the future', () => {
    const s = makeSession('a', 'u', new Date(Date.now() + 1000))
    expect(s.isValid()).toBe(true)
  })
  test('false when expires_at is in the past', () => {
    const s = makeSession('a', 'u', new Date(Date.now() - 1000))
    expect(s.isValid()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SessionRepository — SQL it emits
// ─────────────────────────────────────────────────────────────────────────────

class SpyDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = []
  scriptedRow: Record<string, unknown> | null = null
  scriptedExecute = 0

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params })
    return (this.scriptedRow ? [this.scriptedRow] : []) as T[]
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.queries.push({ sql, params })
    return (this.scriptedRow as T | null) ?? null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.queries.push({ sql, params })
    return this.scriptedExecute
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('SpyDb.raw not implemented')
  }
}

describe('SessionRepository.findValid', () => {
  test('emits a SELECT with id = $1 AND expires_at > $2 LIMIT 1', async () => {
    const db = new SpyDb()
    const repo = new SessionRepository(db as unknown as PostgresDatabase, new EventBus())
    const now = new Date('2026-05-28T12:00:00Z')
    await repo.findValid('sess-x', now)
    const lastSelect = nonNull(db.queries.find((q) => q.sql.startsWith('SELECT')))
    expect(lastSelect.sql).toContain('FROM "session"')
    expect(lastSelect.sql).toContain('"id" = $1')
    expect(lastSelect.sql).toContain('"expires_at" > $2')
    expect(lastSelect.sql).toContain('LIMIT 1')
    expect(lastSelect.params).toEqual(['sess-x', now])
  })
})

describe('SessionRepository.deleteExpired', () => {
  test('emits DELETE WHERE expires_at <= $1, returns affected count', async () => {
    const db = new SpyDb()
    db.scriptedExecute = 3
    const repo = new SessionRepository(db as unknown as PostgresDatabase, new EventBus())
    const cutoff = new Date('2026-05-28T12:00:00Z')
    const removed = await repo.deleteExpired(cutoff)
    expect(removed).toBe(3)
    const exec = nonNull(db.queries.find((q) => q.sql.startsWith('DELETE')))
    expect(exec.sql).toBe('DELETE FROM "session" WHERE "expires_at" <= $1')
    expect(exec.params).toEqual([cutoff])
  })
})

describe('SessionRepository.patchPayload', () => {
  test('shallow-merges into an existing payload + UPDATEs', async () => {
    const db = new SpyDb()
    // Make the UPDATE … RETURNING * return a row so this.update doesn't throw.
    db.scriptedRow = {
      id: 'sess-1',
      user_id: 'u',
      expires_at: new Date(Date.now() + 60_000),
      payload: { csrf_token: 'abc', locale: 'en' },
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SessionRepository(db as unknown as PostgresDatabase, new EventBus())
    const existing = makeSession('sess-1', 'u', new Date(Date.now() + 60_000))
    existing.payload = { csrf_token: 'abc' }
    const next = await repo.patchPayload(existing, { locale: 'en' })
    const update = nonNull(db.queries.find((q) => q.sql.startsWith('UPDATE')))
    expect(update.sql).toContain('UPDATE "session"')
    expect(update.sql).toContain('"payload" = $1')
    expect(update.params[0]).toEqual({ csrf_token: 'abc', locale: 'en' })
    expect(next.payload).toEqual({ csrf_token: 'abc', locale: 'en' })
  })

  test('starts from {} when the existing payload is null', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'sess-2',
      user_id: 'u',
      expires_at: new Date(Date.now() + 60_000),
      payload: { greeted: true },
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SessionRepository(db as unknown as PostgresDatabase, new EventBus())
    const fresh = makeSession('sess-2', 'u', new Date(Date.now() + 60_000))
    // .payload is null by default — Model class field defaults to undefined
    // but the spread `...(null ?? {})` handles it.
    fresh.payload = null
    await repo.patchPayload(fresh, { greeted: true })
    const update = nonNull(db.queries.find((q) => q.sql.startsWith('UPDATE')))
    expect(update.params[0]).toEqual({ greeted: true })
  })

  test('fires the normal session.updating / session.updated events', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'sess-3',
      user_id: 'u',
      expires_at: new Date(Date.now() + 60_000),
      payload: { x: 1 },
      created_at: new Date(),
      updated_at: new Date(),
    }
    const events = new EventBus()
    const fired: string[] = []
    events.on('session.updating', () => {
      fired.push('updating')
    })
    events.on('session.updated', () => {
      fired.push('updated')
    })
    const repo = new SessionRepository(db as unknown as PostgresDatabase, events)
    const s = makeSession('sess-3', 'u', new Date(Date.now() + 60_000))
    await repo.patchPayload(s, { x: 1 })
    expect(fired).toEqual(['updating', 'updated'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AuthProvider — session-driver wiring
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-auth-session-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
})

/**
 * Tiny PostgresDatabase stand-in for the container — SessionRepository's
 * @inject() constructor only requires the *type* to resolve; we never make
 * real calls in these wiring tests.
 */
class StubPostgresDb extends SpyDb {}

async function bootApp(authConfig: Record<string, unknown>): Promise<Application> {
  const app = new Application()
  // Provide a stub PostgresDatabase under the same class identity SessionRepository expects.
  // We import PostgresDatabase as a value so the container can bind it.
  const { PostgresDatabase } = await import('@strav/database')
  app.singleton(PostgresDatabase, () => new StubPostgresDb() as unknown as PostgresDatabase)
  // Register a fake user repo under a known string key — what userResolverService points at.
  app.singleton('users', () => ({
    find: async (id: string) => (id === 'known' ? makeUser('known') : null),
  }))
  return app.useProviders([
    new ConfigProvider({
      logger: {
        default: 'file',
        level: 'error',
        channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
      },
      auth: authConfig,
    }),
    new LoggerProvider(),
    new HttpProvider(),
    new AuthProvider(),
  ])
}

describe('AuthProvider — driver: "session"', () => {
  test('wires a SessionGuard with cookieName / ttl / secure overrides', async () => {
    const app = await bootApp({
      default: 'web',
      guards: {
        web: {
          driver: 'session',
          userResolverService: 'users',
          cookieName: 'app_sid',
          ttlSeconds: 120,
          secure: false,
        },
      },
    })
    await app.start()

    const { AuthManager } = await import('../src/auth_manager.ts')
    const mgr = app.resolve(AuthManager)
    const sessionGuard = mgr.guard('web') as SessionGuard
    expect(sessionGuard).toBeInstanceOf(SessionGuard)
    expect(sessionGuard.name).toBe('web')
    await app.shutdown()
  })

  test('throws ConfigError when userResolverService binding has no find()', async () => {
    const app = new Application()
    const { PostgresDatabase } = await import('@strav/database')
    app.singleton(PostgresDatabase, () => new StubPostgresDb() as unknown as PostgresDatabase)
    // Bind a service WITHOUT a find() method.
    app.singleton('bad_users', () => ({ lookup: () => null }))
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'error',
          channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
        },
        auth: {
          default: 'web',
          guards: {
            web: { driver: 'session', userResolverService: 'bad_users' },
          },
        },
      }),
      new LoggerProvider(),
      new HttpProvider(),
      new AuthProvider(),
    ])
    await expect(app.start()).rejects.toThrow(/does not expose a `find/)
  })
})
