import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseExecutor, PostgresDatabase } from '@strav/database'
import { HttpProvider } from '@strav/http'
import { Application, ConfigProvider, EventBus, LoggerProvider, sha256 } from '@strav/kernel'
import { AuthProvider } from '../src/auth_provider.ts'
import type { Authenticatable } from '../src/authenticatable.ts'
import { AccessToken } from '../src/token/access_token.ts'
import { AccessTokenRepository } from '../src/token/access_token_repository.ts'
import { TokenGuard } from '../src/token/token_guard.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function makeToken(
  id: string,
  userId: string,
  hash: string,
  expiresAt: Date | null = null,
): AccessToken {
  const t = new AccessToken()
  t.id = id
  t.user_id = userId
  t.name = 'test token'
  t.hash = hash
  t.expires_at = expiresAt
  t.created_at = new Date()
  t.updated_at = new Date()
  return t
}

interface FakeCtx {
  request: { headers: Headers }
}

function makeCtx(headers: Record<string, string> = {}): FakeCtx {
  return { request: { headers: new Headers(headers) } }
}

function stubTokenRepo(scripted: { findByPlaintext?: AccessToken | null } = {}) {
  const calls = {
    findByPlaintext: [] as string[],
    delete: [] as string[],
  }
  const stub = {
    async findByPlaintext(plaintext: string) {
      calls.findByPlaintext.push(plaintext)
      return scripted.findByPlaintext ?? null
    },
    async delete(token: AccessToken) {
      calls.delete.push(token.id)
    },
  }
  return { stub: stub as unknown as AccessTokenRepository, calls }
}

// ─────────────────────────────────────────────────────────────────────────────
// TokenGuard.authenticate
// ─────────────────────────────────────────────────────────────────────────────

describe('TokenGuard.authenticate', () => {
  test('returns null when no Authorization header is present', async () => {
    const { stub } = stubTokenRepo()
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx() as never)
    expect(result).toBeNull()
  })

  test('returns null when the scheme is not Bearer', async () => {
    const { stub, calls } = stubTokenRepo()
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    const result = await guard.authenticate(
      makeCtx({ authorization: 'Basic dXNlcjpwYXNz' }) as never,
    )
    expect(result).toBeNull()
    expect(calls.findByPlaintext).toEqual([])
  })

  test('returns null when the token is empty after the scheme', async () => {
    const { stub, calls } = stubTokenRepo()
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx({ authorization: 'Bearer   ' }) as never)
    expect(result).toBeNull()
    expect(calls.findByPlaintext).toEqual([])
  })

  test('returns null when the token is not found', async () => {
    const { stub, calls } = stubTokenRepo({ findByPlaintext: null })
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx({ authorization: 'Bearer abc|def' }) as never)
    expect(result).toBeNull()
    expect(calls.findByPlaintext).toEqual(['abc|def'])
  })

  test('resolves the user via userResolver when the token is valid', async () => {
    const token = makeToken('tok-1', 'user-1', 'sha-hash')
    const { stub } = stubTokenRepo({ findByPlaintext: token })
    const user = makeUser('user-1')
    const guard = new TokenGuard({
      tokens: stub,
      userResolver: (id) => (id === 'user-1' ? user : null),
    })
    const result = await guard.authenticate(makeCtx({ authorization: 'Bearer tok-1|sec' }) as never)
    expect(result).toBe(user as never)
  })

  test('scheme compare is case-insensitive', async () => {
    const token = makeToken('tok-2', 'u', 'h')
    const { stub, calls } = stubTokenRepo({ findByPlaintext: token })
    const guard = new TokenGuard({
      tokens: stub,
      userResolver: () => makeUser('u'),
    })
    await guard.authenticate(makeCtx({ authorization: 'bearer tok-2|x' }) as never)
    expect(calls.findByPlaintext).toEqual(['tok-2|x'])
  })

  test('honors custom headerName + scheme', async () => {
    const token = makeToken('tok-3', 'u', 'h')
    const { stub, calls } = stubTokenRepo({ findByPlaintext: token })
    const guard = new TokenGuard({
      tokens: stub,
      userResolver: () => makeUser('u'),
      headerName: 'x-api-key',
      scheme: 'Token',
    })
    await guard.authenticate(makeCtx({ 'x-api-key': 'Token tok-3|x' }) as never)
    expect(calls.findByPlaintext).toEqual(['tok-3|x'])
  })

  test('returns null when resolver returns null (user deleted)', async () => {
    const token = makeToken('tok-x', 'user-gone', 'h')
    const { stub } = stubTokenRepo({ findByPlaintext: token })
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    const result = await guard.authenticate(makeCtx({ authorization: 'Bearer tok-x|x' }) as never)
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TokenGuard.login / logout
// ─────────────────────────────────────────────────────────────────────────────

describe('TokenGuard.login', () => {
  test('throws — bearer tokens are minted out-of-band', async () => {
    const { stub } = stubTokenRepo()
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    await expect(guard.login(makeCtx() as never, makeUser('u'))).rejects.toThrow(
      /not supported.*minted via AccessTokenRepository/,
    )
  })
})

describe('TokenGuard.logout', () => {
  test('revokes the current request token', async () => {
    const token = makeToken('tok-z', 'u', 'h')
    const { stub, calls } = stubTokenRepo({ findByPlaintext: token })
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    await guard.logout(makeCtx({ authorization: 'Bearer tok-z|x' }) as never)
    expect(calls.findByPlaintext).toEqual(['tok-z|x'])
    expect(calls.delete).toEqual(['tok-z'])
  })

  test('no-op when no Authorization header is present', async () => {
    const { stub, calls } = stubTokenRepo()
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    await guard.logout(makeCtx() as never)
    expect(calls.findByPlaintext).toEqual([])
    expect(calls.delete).toEqual([])
  })

  test('no-op when the token does not resolve to a row', async () => {
    const { stub, calls } = stubTokenRepo({ findByPlaintext: null })
    const guard = new TokenGuard({ tokens: stub, userResolver: () => null })
    await guard.logout(makeCtx({ authorization: 'Bearer stale|x' }) as never)
    expect(calls.findByPlaintext).toEqual(['stale|x'])
    expect(calls.delete).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AccessToken.isValid
// ─────────────────────────────────────────────────────────────────────────────

describe('AccessToken.isValid', () => {
  test('true when expires_at is null (never expires)', () => {
    expect(makeToken('a', 'u', 'h', null).isValid()).toBe(true)
  })
  test('true when expires_at is in the future', () => {
    expect(makeToken('a', 'u', 'h', new Date(Date.now() + 1000)).isValid()).toBe(true)
  })
  test('false when expires_at is in the past', () => {
    expect(makeToken('a', 'u', 'h', new Date(Date.now() - 1000)).isValid()).toBe(false)
  })
})

describe('AccessToken serialization', () => {
  test('JSON.stringify omits the hash field (@hidden)', () => {
    const t = makeToken('tok-1', 'user-1', 'sha-hash-secret', new Date(Date.now() + 60_000))
    const parsed = JSON.parse(JSON.stringify(t)) as Record<string, unknown>
    expect(parsed.hash).toBeUndefined()
    expect(parsed.id).toBe('tok-1')
    expect(parsed.user_id).toBe('user-1')
    expect(parsed.name).toBe('test token')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AccessTokenRepository
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal fake DB that simulates a single-table store keyed by id. */
class FakeTokenDb {
  rows = new Map<string, Record<string, unknown>>()
  scriptedExecute = 0

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    if (/WHERE "id" = \$1/i.test(sql)) {
      const row = this.rows.get(String(params[0]))
      return (row ? [row] : []) as T[]
    }
    return []
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    if (/RETURNING/i.test(sql) && /INSERT INTO/i.test(sql)) {
      // Mimic INSERT … RETURNING * by storing the bound columns + returning them.
      const row = this.captureInsert(sql, params)
      this.rows.set(String(row.id), row)
      return row as T
    }
    if (/WHERE "id" = \$1/i.test(sql)) {
      const row = this.rows.get(String(params[0]))
      return (row as T | null) ?? null
    }
    return null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    if (/DELETE FROM "access_token" WHERE "user_id" = \$1/i.test(sql)) {
      const userId = String(params[0])
      let removed = 0
      for (const [id, row] of [...this.rows]) {
        if (row.user_id === userId) {
          this.rows.delete(id)
          removed++
        }
      }
      return removed
    }
    return this.scriptedExecute
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('FakeTokenDb.raw not implemented')
  }

  /** Extract `INSERT INTO "access_token" (col, col, …) VALUES ($1, $2, …)` into a row. */
  private captureInsert(sql: string, params: readonly unknown[]): Record<string, unknown> {
    const match = /\(([^)]+)\) VALUES/i.exec(sql)
    const colsExpr = nonNull(match?.[1], `FakeTokenDb: cannot parse INSERT columns from ${sql}`)
    const cols = colsExpr.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row: Record<string, unknown> = {}
    cols.forEach((c, i) => {
      row[c] = params[i]
    })
    return row
  }
}

describe('AccessTokenRepository.createToken', () => {
  test('mints a plaintext + persists the SHA-256 hash of the secret half', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    const minted = await repo.createToken('user-1', 'CI token')
    const parts = minted.plaintext.split('|')
    expect(parts).toHaveLength(2)
    const idPart = nonNull(parts[0])
    const secretPart = nonNull(parts[1])
    expect(idPart.length).toBe(26) // ULID
    expect(secretPart.length).toBeGreaterThanOrEqual(40) // 32 bytes base64url ≈ 43 chars
    expect(minted.model.id).toBe(idPart)
    expect(minted.model.user_id).toBe('user-1')
    expect(minted.model.name).toBe('CI token')
    expect(minted.model.hash).toBe(sha256(secretPart))
    expect(minted.model.expires_at).toBeNull()
  })

  test('sets expires_at when expiresInSeconds is given', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    const before = Date.now()
    const minted = await repo.createToken('user-1', 'short', { expiresInSeconds: 60 })
    const expiresMs = nonNull(minted.model.expires_at).getTime()
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60_000 - 50)
    expect(expiresMs).toBeLessThanOrEqual(before + 60_000 + 50)
  })
})

describe('AccessTokenRepository.findByPlaintext', () => {
  test('returns null for malformed plaintext (no separator)', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    expect(await repo.findByPlaintext('no-separator-here')).toBeNull()
    expect(await repo.findByPlaintext('|missing-id')).toBeNull()
    expect(await repo.findByPlaintext('missing-secret|')).toBeNull()
  })

  test('returns null when the id half references no row', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    expect(await repo.findByPlaintext('ghost|x')).toBeNull()
  })

  test('returns null when the secret hash does not match', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    const minted = await repo.createToken('user-1', 'name')
    const idPart = nonNull(minted.plaintext.split('|')[0])
    expect(await repo.findByPlaintext(`${idPart}|wrong-secret`)).toBeNull()
  })

  test('returns the row when the secret matches', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    const minted = await repo.createToken('user-2', 'name')
    const found = nonNull(await repo.findByPlaintext(minted.plaintext))
    expect(found.id).toBe(minted.model.id)
    expect(found.user_id).toBe('user-2')
  })

  test('returns null when the row is expired', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    const minted = await repo.createToken('user-3', 'name', { expiresInSeconds: 60 })
    // Look it up with a "now" past the expiry.
    const future = new Date(Date.now() + 120_000)
    const found = await repo.findByPlaintext(minted.plaintext, future)
    expect(found).toBeNull()
  })
})

describe('AccessTokenRepository.revokeAllForUser', () => {
  test('deletes every row matching user_id, returns the count', async () => {
    const db = new FakeTokenDb()
    const repo = new AccessTokenRepository(db as unknown as PostgresDatabase, new EventBus())
    await repo.createToken('victim', 'a')
    await repo.createToken('victim', 'b')
    await repo.createToken('survivor', 'c')
    const removed = await repo.revokeAllForUser('victim')
    expect(removed).toBe(2)
    expect(db.rows.size).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AuthProvider — token-driver wiring
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-auth-token-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
})

describe('AuthProvider — driver: "token"', () => {
  test('wires a TokenGuard with headerName + scheme overrides', async () => {
    const app = new Application()
    const { PostgresDatabase } = await import('@strav/database')
    app.singleton(PostgresDatabase, () => new FakeTokenDb() as unknown as PostgresDatabase)
    app.singleton('users', () => ({
      find: async (id: string) => (id === 'known' ? makeUser('known') : null),
    }))
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'error',
          channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
        },
        auth: {
          default: 'api',
          guards: {
            api: {
              driver: 'token',
              userResolverService: 'users',
              headerName: 'x-api-key',
              scheme: 'Token',
            },
          },
        },
      }),
      new LoggerProvider(),
      new HttpProvider(),
      new AuthProvider(),
    ])
    await app.start()

    const { AuthManager } = await import('../src/auth_manager.ts')
    const mgr = app.resolve(AuthManager)
    const tokenGuard = mgr.guard('api') as TokenGuard
    expect(tokenGuard).toBeInstanceOf(TokenGuard)
    expect(tokenGuard.name).toBe('api')
    await app.shutdown()
  })
})
