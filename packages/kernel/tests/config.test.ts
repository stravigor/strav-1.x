import { describe, expect, test } from 'bun:test'
import { ConfigRepository } from '../src/config/configuration.ts'
import { Application } from '../src/core/index.ts'
import { ConfigProvider } from '../src/providers/config_provider.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigRepository.get', () => {
  test('top-level key', () => {
    const c = new ConfigRepository({ name: 'my-app' })
    expect(c.get('name')).toBe('my-app')
  })

  test('dotted path walks nested objects', () => {
    const c = new ConfigRepository({
      database: { host: '127.0.0.1', tenant: { bypass: { username: 'admin' } } },
    })
    expect(c.get('database.host')).toBe('127.0.0.1')
    expect(c.get('database.tenant.bypass.username')).toBe('admin')
  })

  test('missing path returns undefined', () => {
    const c = new ConfigRepository({ database: { host: 'x' } })
    expect(c.get('database.nope')).toBeUndefined()
    expect(c.get('missing.entirely')).toBeUndefined()
  })

  test('default is returned for missing path', () => {
    const c = new ConfigRepository()
    expect(c.get('a.b', 'default')).toBe('default')
    expect(c.get<number>('a.b', 0)).toBe(0)
  })

  test('explicit-undefined value: default still returned', () => {
    const c = new ConfigRepository({ a: { b: undefined } })
    expect(c.get('a.b', 'default')).toBe('default')
  })

  test('falsy values (0, "", false) are returned, not replaced by default', () => {
    const c = new ConfigRepository({ a: 0, b: '', c: false })
    expect(c.get('a', 999)).toBe(0)
    expect(c.get('b', 'x')).toBe('')
    expect(c.get<boolean>('c', true)).toBe(false)
  })

  test('typed generic compiles and returns correctly', () => {
    const c = new ConfigRepository({ port: 3000 })
    const port = c.get<number>('port', 5432)
    expect(typeof port).toBe('number')
    expect(port).toBe(3000)
  })
})

describe('ConfigRepository.has', () => {
  test('true for existing paths, false otherwise', () => {
    const c = new ConfigRepository({ db: { host: 'x' } })
    expect(c.has('db')).toBe(true)
    expect(c.has('db.host')).toBe(true)
    expect(c.has('db.port')).toBe(false)
    expect(c.has('cache')).toBe(false)
  })
})

describe('ConfigRepository.section', () => {
  test('returns the sub-tree', () => {
    const c = new ConfigRepository({ db: { host: 'x', port: 5432 } })
    const db = c.section<{ host: string; port: number }>('db')
    expect(db).toEqual({ host: 'x', port: 5432 })
  })

  test('throws on missing section', () => {
    const c = new ConfigRepository()
    expect(() => c.section('missing')).toThrow(/no section at "missing"/)
  })
})

describe('ConfigRepository.all', () => {
  test('returns a cloned snapshot', () => {
    const original = { db: { host: 'x' } }
    const c = new ConfigRepository(original)
    const snap = c.all()
    expect(snap).toEqual(original)
    // mutating the snapshot doesn't affect the repository
    ;(snap as { db: { host: string } }).db.host = 'y'
    expect(c.get('db.host')).toBe('x')
  })

  test('constructor input is cloned (no external mutation can poison the repo)', () => {
    const original: Record<string, unknown> = { db: { host: 'x' } }
    const c = new ConfigRepository(original)
    ;(original.db as { host: string }).host = 'mutated'
    expect(c.get('db.host')).toBe('x')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigRepository.set', () => {
  test('top-level write', () => {
    const c = new ConfigRepository()
    c.set('name', 'app')
    expect(c.get('name')).toBe('app')
  })

  test('dotted-path write creates intermediate objects', () => {
    const c = new ConfigRepository()
    c.set('a.b.c', 1)
    expect(c.get('a.b.c')).toBe(1)
  })

  test('overwrites an existing value', () => {
    const c = new ConfigRepository({ a: 1 })
    c.set('a', 2)
    expect(c.get('a')).toBe(2)
  })

  test('invalid keys throw', () => {
    const c = new ConfigRepository()
    expect(() => c.set('', 1)).toThrow(/invalid key/)
  })

  test('returns this for chaining', () => {
    const c = new ConfigRepository()
    const r = c.set('a', 1).set('b', 2)
    expect(r).toBe(c)
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBe(2)
  })
})

describe('ConfigRepository.merge', () => {
  test('merges multiple dotted-path entries', () => {
    const c = new ConfigRepository()
    c.merge({ 'app.name': 'x', 'app.port': 3000, 'db.host': '127.0.0.1' })
    expect(c.get('app.name')).toBe('x')
    expect(c.get('app.port')).toBe(3000)
    expect(c.get('db.host')).toBe('127.0.0.1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Freeze
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigRepository.freeze', () => {
  test('isFrozen reports state', () => {
    const c = new ConfigRepository()
    expect(c.isFrozen()).toBe(false)
    c.freeze()
    expect(c.isFrozen()).toBe(true)
  })

  test('set after freeze throws', () => {
    const c = new ConfigRepository({ a: 1 })
    c.freeze()
    expect(() => c.set('a', 2)).toThrow(/frozen after app:booted/)
  })

  test('reads still work after freeze', () => {
    const c = new ConfigRepository({ a: 1 })
    c.freeze()
    expect(c.get('a')).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration with Application + ConfigProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigProvider', () => {
  test('binds ConfigRepository under both the class and the string key', async () => {
    const app = new Application().use(
      new ConfigProvider({ app: { name: 'test' }, db: { host: 'x' } }),
    )
    await app.start({ signalHandlers: false })

    const byClass = app.resolve(ConfigRepository)
    const byName = app.resolve<ConfigRepository>('config')
    expect(byClass).toBe(byName)
    expect(byClass.get('app.name')).toBe('test')
    expect(byClass.get('db.host')).toBe('x')

    await app.shutdown()
  })

  test('config is frozen automatically after app:booted', async () => {
    const app = new Application().use(new ConfigProvider({ a: 1 }))
    await app.start({ signalHandlers: false })

    const config = app.resolve(ConfigRepository)
    expect(config.isFrozen()).toBe(true)
    expect(() => config.set('a', 2)).toThrow(/frozen/)

    await app.shutdown()
  })

  test('ConfigProvider is registered with name "config" and no deps', () => {
    const p = new ConfigProvider({})
    expect(p.name).toBe('config')
    expect(p.dependencies).toEqual([])
  })

  test('ConfigProvider.fromDirectory scans + auto-keys + applies overrides', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'cfg-discover-'))
    try {
      await writeFile(join(dir, 'app.ts'), `export default { name: 'auto-app' }`, 'utf8')
      await writeFile(
        join(dir, 'database.ts'),
        `export default { host: 'auto-db' }`,
        'utf8',
      )
      // Underscore-prefix is skipped.
      await writeFile(join(dir, '_local.ts'), `export default { skipped: true }`, 'utf8')
      // Non-ts files are ignored.
      await writeFile(join(dir, 'notes.md'), `not a config`, 'utf8')

      const provider = await ConfigProvider.fromDirectory({
        directory: dir,
        overrides: { app: { name: 'overlay' } },
      })
      const app = new Application().use(provider)
      await app.start({ signalHandlers: false })

      const config = app.resolve(ConfigRepository)
      expect(config.get('app.name')).toBe('overlay') // override wins
      expect(config.get('database.host')).toBe('auto-db')
      expect(config.get('_local.skipped')).toBeUndefined()
      expect(config.get('local.skipped')).toBeUndefined()
      expect(config.get('notes')).toBeUndefined()

      await app.shutdown()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ConfigProvider.fromDirectory throws when directory is missing', async () => {
    await expect(
      ConfigProvider.fromDirectory({ directory: '/nonexistent/strav-cfg-test' }),
    ).rejects.toThrow(/could not read/)
  })

  test('config is mutable during register/boot (before app:booted fires)', async () => {
    const app = new Application()

    class WriterProvider {
      readonly name = 'writer'
      readonly dependencies = ['config']
      register(): void {}
      boot(app2: Application): void {
        const config = app2.resolve(ConfigRepository)
        // boot runs BEFORE app:booted is emitted → still mutable
        config.set('boot.flag', true)
      }
      shutdown(): void {}
    }

    app.useProviders([new ConfigProvider(), new WriterProvider() as never])
    await app.start({ signalHandlers: false })

    const config = app.resolve(ConfigRepository)
    expect(config.get('boot.flag')).toBe(true)
    expect(config.isFrozen()).toBe(true)

    await app.shutdown()
  })
})
