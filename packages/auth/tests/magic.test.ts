import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpProvider } from '@strav/http'
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'
import { AuthProvider } from '../src/auth_provider.ts'
import { MagicLinkError, MagicLinkManager } from '../src/magic/magic_link_manager.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fake Database
// ─────────────────────────────────────────────────────────────────────────────

class FakeMagicDb {
  rows = new Map<string, any>()
  executeCalls: { sql: string; params: any[] }[] = []
  nowValue = new Date()

  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    if (sql.includes('strav_magic_links')) {
      const token = params[0] as string
      const row = [...this.rows.values()].find((r) => r.token === token)
      return (row as T | null) ?? null
    }
    return null
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.executeCalls.push({ sql, params: [...params] })
    if (/INSERT INTO "strav_magic_links"/i.test(sql)) {
      const [id, userId, token, redirectTo, expiresAt] = params
      this.rows.set(id as string, {
        id,
        user_id: userId,
        token,
        redirect_to: redirectTo,
        expires_at: expiresAt,
        used_at: null,
      })
      return 1
    }
    if (/UPDATE "strav_magic_links" SET used_at =/i.test(sql)) {
      const id = params[0] as string
      const row = this.rows.get(id)
      if (row) {
        row.used_at = this.nowValue
        return 1
      }
    }
    return 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MagicLinkManager', () => {
  test('create generates url with default options', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any, baseUrl: 'https://example.com' })

    const url = await manager.create('user-1')
    expect(url).toMatch(/^https:\/\/example.com\/auth\/magic\/[a-f0-9]{64}$/)

    expect(db.rows.size).toBe(1)
    const row = [...db.rows.values()][0]
    expect(row.user_id).toBe('user-1')
    expect(row.redirect_to).toBeNull()
    expect(row.used_at).toBeNull()

    // 15 min TTL check
    const diff = new Date(row.expires_at).getTime() - Date.now()
    expect(diff).toBeGreaterThan(14 * 60 * 1000)
    expect(diff).toBeLessThan(16 * 60 * 1000)
  })

  test('create accepts custom overrides', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any, baseUrl: 'https://example.com' })

    const url = await manager.create('user-2', {
      ttl: '1h',
      redirectTo: '/dashboard',
      path: '/signin/magic',
    })
    expect(url).toMatch(/^https:\/\/example.com\/signin\/magic\/[a-f0-9]{64}$/)

    const row = [...db.rows.values()][0]
    expect(row.redirect_to).toBe('/dashboard')

    // 1 hr TTL check
    const diff = new Date(row.expires_at).getTime() - Date.now()
    expect(diff).toBeGreaterThan(59 * 60 * 1000)
    expect(diff).toBeLessThan(61 * 60 * 1000)
  })

  test('create throws error if baseUrl is missing', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any })
    expect(manager.create('user-1')).rejects.toThrow(MagicLinkError)
  })

  test('consume successfully signs in and marks used', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any, baseUrl: 'https://example.com' })

    const url = await manager.create('user-3', { redirectTo: '/home' })
    const token = url.split('/').pop()!

    const result = await manager.consume(token)
    expect(result).toEqual({ userId: 'user-3', redirectTo: '/home' })

    const row = [...db.rows.values()][0]
    expect(row.used_at).toBe(db.nowValue)
  })

  test('consume fails for invalid token', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any, baseUrl: 'https://example.com' })

    expect(manager.consume('nonexistent-token')).rejects.toThrow(MagicLinkError)
  })

  test('consume fails for already used token', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any, baseUrl: 'https://example.com' })

    const url = await manager.create('user-4')
    const token = url.split('/').pop()!

    await manager.consume(token)

    // Second consume should fail
    expect(manager.consume(token)).rejects.toThrow(MagicLinkError)
  })

  test('consume fails for expired token', async () => {
    const db = new FakeMagicDb()
    const manager = new MagicLinkManager({ db: db as any, baseUrl: 'https://example.com' })

    // Create a magic link that expired 1 second ago
    const url = await manager.create('user-5', { ttl: -1 })
    const token = url.split('/').pop()!

    expect(manager.consume(token)).rejects.toThrow(MagicLinkError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Container Wiring Test
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-auth-magic-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
})

describe('AuthProvider — MagicLinkManager binding', () => {
  test('wires a MagicLinkManager from config', async () => {
    const app = new Application()
    const { PostgresDatabase } = await import('@strav/database')
    app.singleton(PostgresDatabase, () => new FakeMagicDb() as any)
    const { MemoryGuard } = await import('../src/memory_guard.ts')
    app.singleton(
      'memory_guard',
      () => new MemoryGuard({ name: 'memory', userResolver: () => null }),
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
          key: 'app-secret-key-12345678901234567890',
        },
        auth: {
          default: 'memory',
          guards: {
            memory: { driver: 'custom', service: 'memory_guard' },
          },
          magic: {
            path: '/custom/magic-link',
          },
        },
      }),
      new LoggerProvider(),
      new HttpProvider(),
      new AuthProvider(),
    ])
    await app.start()

    const manager = app.resolve(MagicLinkManager)
    expect(manager).toBeInstanceOf(MagicLinkManager)

    const url = await manager.create('user-99')
    expect(url).toMatch(/^https:\/\/myapp.com\/custom\/magic-link\/[a-f0-9]{64}$/)

    await app.shutdown()
  })
})
