import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Application } from '../src/core/index.ts'
import { ConfigError } from '../src/exceptions/index.ts'
import { LogManager } from '../src/logger/log_manager.ts'
import { Logger } from '../src/logger/logger.ts'
import { compileRedactor } from '../src/logger/redact.ts'
import type { LoggerConfig } from '../src/logger/types.ts'
import { ConfigProvider, LoggerProvider } from '../src/providers/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TmpDirHandle {
  path: string
  cleanup: () => void
}

function tmp(): TmpDirHandle {
  const path = mkdtempSync(join(tmpdir(), 'strav-logger-'))
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  }
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  const text = readFileSync(filePath, 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

// SonicBoom (Pino's destination) buffers; our raw fs WriteStream flushes
// synchronously enough for testing on `end()`. Always flush via the manager.

async function flush(manager: LogManager): Promise<void> {
  await manager.shutdown()
}

// ─────────────────────────────────────────────────────────────────────────────
// Redactor
// ─────────────────────────────────────────────────────────────────────────────

describe('compileRedactor', () => {
  test('no paths → pass-through', () => {
    const r = compileRedactor()
    const input = { a: 1, b: 'two' }
    expect(r(input)).toEqual(input)
  })

  test('exact top-level path', () => {
    const r = compileRedactor({ paths: ['password'] })
    expect(r({ password: 'x', user: 'liva' })).toEqual({ password: '[REDACTED]', user: 'liva' })
  })

  test('exact nested path', () => {
    const r = compileRedactor({ paths: ['headers.authorization'] })
    expect(
      r({
        headers: { authorization: 'Bearer x', accept: '*/*' },
        body: { ok: true },
      }),
    ).toEqual({
      headers: { authorization: '[REDACTED]', accept: '*/*' },
      body: { ok: true },
    })
  })

  test('single-segment wildcard `*.password`', () => {
    const r = compileRedactor({ paths: ['*.password'] })
    const out = r({ a: { password: 1 }, b: { password: 2 }, c: { other: 3 } })
    expect(out).toEqual({
      a: { password: '[REDACTED]' as unknown as number },
      b: { password: '[REDACTED]' as unknown as number },
      c: { other: 3 },
    })
  })

  test('deep wildcard `**.token` matches any depth', () => {
    const r = compileRedactor({ paths: ['**.token'] })
    expect(
      r({
        token: 'a',
        nested: { token: 'b' },
        deeper: { x: { token: 'c' } },
        other: 'kept',
      }),
    ).toEqual({
      token: '[REDACTED]',
      nested: { token: '[REDACTED]' },
      deeper: { x: { token: '[REDACTED]' } },
      other: 'kept',
    })
  })

  test('custom censor string', () => {
    const r = compileRedactor({ paths: ['password'], censor: '***' })
    expect(r({ password: 'x' })).toEqual({ password: '***' })
  })

  test('original object is not mutated', () => {
    const r = compileRedactor({ paths: ['password'] })
    const input = { password: 'x', y: 1 }
    r(input)
    expect(input).toEqual({ password: 'x', y: 1 })
  })

  test('arrays are walked', () => {
    const r = compileRedactor({ paths: ['**.token'] })
    expect(r({ list: [{ token: 'a' }, { token: 'b' }, { other: 'c' }] })).toEqual({
      list: [{ token: '[REDACTED]' }, { token: '[REDACTED]' }, { other: 'c' }],
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Logger basics — via single-file channel for inspectability
// ─────────────────────────────────────────────────────────────────────────────

describe('Logger (via single channel)', () => {
  const dir = tmp()
  afterEach(() => {
    // intentionally per-test: avoid file handle leaks across tests
  })

  function makeManager(overrides: Partial<LoggerConfig> = {}): {
    manager: LogManager
    file: string
  } {
    const file = join(dir.path, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
    const manager = new LogManager({
      default: 'file',
      level: 'trace',
      channels: { file: { driver: 'single', path: file } },
      ...overrides,
    })
    return { manager, file }
  }

  test('info() writes a structured line with level/msg/fields', async () => {
    const { manager, file } = makeManager()
    const log = manager.default()
    log.info('user.signed_in', { userId: 'u1', ip: '1.2.3.4' })
    await flush(manager)
    const [line] = readLines(file)
    expect(line).toBeDefined()
    expect(line?.level).toBe(30)
    expect(line?.msg).toBe('user.signed_in')
    expect(line?.userId).toBe('u1')
    expect(line?.ip).toBe('1.2.3.4')
    expect(typeof line?.time).toBe('number')
    expect(typeof line?.pid).toBe('number')
    expect(typeof line?.hostname).toBe('string')
  })

  test('every level method maps to the right Pino level', async () => {
    const { manager, file } = makeManager()
    const log = manager.default()
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')
    await flush(manager)
    expect(readLines(file).map((l) => l.level)).toEqual([10, 20, 30, 40, 50, 60])
  })

  test('level threshold drops lower-level events', async () => {
    const { manager, file } = makeManager({ level: 'warn' })
    const log = manager.default()
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    await flush(manager)
    expect(readLines(file).map((l) => l.msg)).toEqual(['w', 'e'])
  })

  test('child() persists context into every emit', async () => {
    const { manager, file } = makeManager()
    const log = manager.default().child({ requestId: 'req-1', userId: 'u1' })
    log.info('processed')
    log.warn('slow', { duration_ms: 412 })
    await flush(manager)
    const lines = readLines(file)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.requestId).toBe('req-1')
    expect(lines[0]?.userId).toBe('u1')
    expect(lines[1]?.requestId).toBe('req-1')
    expect(lines[1]?.duration_ms).toBe(412)
  })

  test('child() does not mutate parent context', async () => {
    const { manager, file } = makeManager()
    const parent = manager.default()
    parent.child({ requestId: 'req-1' }).info('child')
    parent.info('parent')
    await flush(manager)
    const lines = readLines(file)
    expect(lines[0]?.requestId).toBe('req-1')
    expect(lines[1]?.requestId).toBeUndefined()
  })

  test('log(level, ...) dispatches dynamically; silent is a no-op', async () => {
    const { manager, file } = makeManager()
    const log = manager.default()
    log.log('warn', 'dyn-warn')
    log.log('silent', 'should-not-appear')
    await flush(manager)
    const lines = readLines(file)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.msg).toBe('dyn-warn')
    expect(lines[0]?.level).toBe(40)
  })

  test('redact paths are applied before serialization', async () => {
    const { manager, file } = makeManager({
      redact: { paths: ['password', '**.token'] },
    })
    const log = manager.default()
    log.info('signin', {
      password: 'pw',
      user: { name: 'liva', token: 'abc' },
      keep: 1,
    })
    await flush(manager)
    const [line] = readLines(file)
    expect(line?.password).toBe('[REDACTED]')
    expect((line?.user as Record<string, unknown>)?.token).toBe('[REDACTED]')
    expect((line?.user as Record<string, unknown>)?.name).toBe('liva')
    expect(line?.keep).toBe(1)
  })

  test('channel() resolves a different channel via the manager', async () => {
    const fileA = join(dir.path, `a-${Date.now()}.log`)
    const fileB = join(dir.path, `b-${Date.now()}.log`)
    const manager = new LogManager({
      default: 'a',
      level: 'info',
      channels: {
        a: { driver: 'single', path: fileA },
        b: { driver: 'single', path: fileB },
      },
    })
    manager.default().info('to-a')
    manager.default().channel('b').error('to-b')
    await flush(manager)
    expect(readLines(fileA).map((l) => l.msg)).toEqual(['to-a'])
    expect(readLines(fileB).map((l) => l.msg)).toEqual(['to-b'])
  })

  test('channel() on a standalone logger (no manager) throws ConfigError', () => {
    // Build a logger without a manager — direct construction path.
    const { manager } = makeManager()
    const log = new Logger(manager.default().raw, (v) => v)
    expect(() => log.channel('whatever')).toThrow(ConfigError)
  })

  afterEach(() => {
    // best-effort cleanup of any open file handles before the next test
  })

  // One-shot dir cleanup at the end of the suite
  test('zzz cleanup tmp dir', () => {
    dir.cleanup()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Channels — stack fan-out, daily rotation, syslog stub
// ─────────────────────────────────────────────────────────────────────────────

describe('Stack channel', () => {
  const dir = tmp()
  afterEach(() => {
    // per-suite cleanup at end
  })

  test('fans one event out to every child channel', async () => {
    const a = join(dir.path, 'a.log')
    const b = join(dir.path, 'b.log')
    const manager = new LogManager({
      default: 'stack',
      level: 'info',
      channels: {
        stack: { driver: 'stack', children: ['a', 'b'] },
        a: { driver: 'single', path: a },
        b: { driver: 'single', path: b },
      },
    })
    manager.default().info('fan')
    await manager.shutdown()
    expect(readLines(a).map((l) => l.msg)).toEqual(['fan'])
    expect(readLines(b).map((l) => l.msg)).toEqual(['fan'])
  })

  test('rejects a child that does not exist', () => {
    expect(
      () =>
        new LogManager({
          default: 'stack',
          level: 'info',
          channels: {
            stack: { driver: 'stack', children: ['missing'] },
          },
        }),
    ).toThrow(ConfigError)
  })

  test('rejects a stack channel with zero children', () => {
    const manager = new LogManager({
      default: 'stack',
      level: 'info',
      channels: {
        stack: { driver: 'stack', children: [] },
      },
    })
    expect(() => manager.default()).toThrow(ConfigError)
  })

  test('cleanup', () => dir.cleanup())
})

describe('Daily channel', () => {
  const dir = tmp()

  test('writes to the date-suffixed file', async () => {
    const fixed = Date.UTC(2026, 4, 27, 12, 0, 0)
    // Two writes on the same day → single file.
    const manager = new LogManager({
      default: 'daily',
      level: 'info',
      channels: {
        daily: { driver: 'daily', path: join(dir.path, 'app.log'), days: 14 },
      },
    })
    // Replace destination clock by using a daily destination directly via
    // re-constructing the manager with a customized path. We can verify the
    // file name pattern as a smoke test on the manager's wiring; the actual
    // rotation logic is unit-tested by the destination directly below.
    manager.default().info('today')
    await manager.shutdown()
    const files = readdirSync(dir.path).filter((f) => f.startsWith('app-') && f.endsWith('.log'))
    expect(files.length).toBe(1)
    // sanity: today's file
    expect(files[0]).toMatch(/^app-\d{4}-\d{2}-\d{2}\.log$/)
    expect(fixed).toBeGreaterThan(0) // keep fixed referenced; explicit clock-injection covered in rotation test
  })

  test('rotates to a new file on day change', async () => {
    const { dailyDestination } = await import('../src/logger/destinations/daily_destination.ts')
    let now = Date.UTC(2026, 4, 27, 23, 59, 0)
    const dest = dailyDestination({
      path: join(dir.path, 'rot.log'),
      days: 14,
      now: () => now,
    })
    dest.write('{"msg":"before"}\n')
    now = Date.UTC(2026, 4, 28, 0, 0, 1)
    dest.write('{"msg":"after"}\n')
    await dest.close?.()
    const day1 = readFileSync(join(dir.path, 'rot-2026-05-27.log'), 'utf8').trim()
    const day2 = readFileSync(join(dir.path, 'rot-2026-05-28.log'), 'utf8').trim()
    expect(day1).toContain('"before"')
    expect(day2).toContain('"after"')
  })

  test('prunes files older than `days` at construction', async () => {
    const { dailyDestination } = await import('../src/logger/destinations/daily_destination.ts')
    // Seed an old file with an old mtime.
    const oldPath = join(dir.path, 'prune-1999-01-01.log')
    writeFileSync(oldPath, 'old\n')
    const oldTime = new Date(1999, 0, 1).getTime() / 1000
    const { utimesSync } = await import('node:fs')
    utimesSync(oldPath, oldTime, oldTime)

    const dest = dailyDestination({
      path: join(dir.path, 'prune.log'),
      days: 7,
    })
    await dest.close?.()
    expect(readdirSync(dir.path).includes('prune-1999-01-01.log')).toBe(false)
  })

  test('cleanup', () => dir.cleanup())
})

describe('Syslog channel', () => {
  test('throws ConfigError when constructed (driver is M4)', () => {
    expect(() =>
      new LogManager({
        default: 'syslog',
        level: 'info',
        channels: { syslog: { driver: 'syslog' } },
      }).default(),
    ).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LogManager validation
// ─────────────────────────────────────────────────────────────────────────────

describe('LogManager.validate', () => {
  test('rejects an unknown default channel', () => {
    expect(
      () =>
        new LogManager({
          default: 'nope',
          level: 'info',
          channels: {},
        }),
    ).toThrow(ConfigError)
  })

  test('rejects an invalid level string', () => {
    expect(
      () =>
        new LogManager({
          default: 'x',
          // biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
          level: 'shouty' as any,
          channels: { x: { driver: 'stderr' } },
        }),
    ).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LoggerProvider — container binding
// ─────────────────────────────────────────────────────────────────────────────

describe('LoggerProvider', () => {
  const dir = tmp()

  let originalWrite: typeof process.stderr.write
  beforeEach(() => {
    originalWrite = process.stderr.write.bind(process.stderr)
  })
  afterEach(() => {
    process.stderr.write = originalWrite
  })

  test('binds Logger / LogManager / "logger" alias after boot', async () => {
    const file = join(dir.path, 'provider.log')
    const app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'info',
          channels: { file: { driver: 'single', path: file } },
        },
      }),
      new LoggerProvider(),
    ])
    await app.start({ signalHandlers: false })
    try {
      const log = app.resolve(Logger)
      const alias = app.resolve<Logger>('logger')
      expect(alias).toBe(log)
      log.info('booted')
    } finally {
      await app.shutdown()
    }
    const lines = readLines(file)
    expect(lines[0]?.msg).toBe('booted')
  })

  test('throws ConfigError at boot when config.logger is missing', async () => {
    const app = new Application()
    app.useProviders([new ConfigProvider({}), new LoggerProvider()])
    await expect(app.start({ signalHandlers: false })).rejects.toThrow(ConfigError)
  })

  test('cleanup', () => dir.cleanup())
})
