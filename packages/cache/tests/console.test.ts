/**
 * Unit tests for the cache:* commands. Cache is stubbed with the
 * MemoryCache driver — the commands are thin pass-throughs to the
 * `Cache` primitive, so behaviour-correctness is covered there;
 * here we verify argv binding + output + the `--force` confirm gate.
 */

import { describe, expect, test } from 'bun:test'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { Cache } from '../src/cache.ts'
import { CacheClear } from '../src/console/cache_clear.ts'
import { CacheForget } from '../src/console/cache_forget.ts'
import { CacheList } from '../src/console/cache_list.ts'
import { MemoryCache } from '../src/drivers/memory/memory_cache.ts'

class MemStream {
  chunks: string[] = []
  write(c: string): boolean {
    this.chunks.push(c)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

function buildCtx(app: Application): {
  ctx: (args?: readonly string[], flags?: Record<string, string | boolean>) => CommandContext
  stdout: MemStream
  stderr: MemStream
} {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx = (
    args: readonly string[] = [],
    flags: Record<string, string | boolean> = {},
  ): CommandContext => ({ args, flags, out, app })
  return { ctx, stdout, stderr }
}

function makeApp(config?: Record<string, unknown>): { app: Application; cache: MemoryCache } {
  const app = new Application()
  const cache = new MemoryCache()
  app.singleton(Cache, () => cache)
  const repo = new ConfigRepository(config !== undefined ? { cache: config } : {})
  app.singleton(ConfigRepository, () => repo)
  return { app, cache }
}

// ─── cache:list ──────────────────────────────────────────────────────────

describe('cache:list', () => {
  test('prints driver + non-secret config fields', async () => {
    const { app } = makeApp({ driver: 'redis', url: 'redis://127.0.0.1:6379', prefix: 'app:' })
    const env = buildCtx(app)
    const exit = await new CacheList().handle(env.ctx())
    expect(exit).toBe(0)
    const text = env.stdout.text()
    expect(text).toContain('Driver: redis')
    expect(text).toContain('url: redis://127.0.0.1:6379')
    expect(text).toContain('prefix: app:')
  })

  test('masks values whose key includes "password"', async () => {
    const { app } = makeApp({ driver: 'memcached', host: 'mc.example', password: 'sup3rsecret' })
    const env = buildCtx(app)
    await new CacheList().handle(env.ctx())
    const text = env.stdout.text()
    expect(text).toContain('host: mc.example')
    expect(text).toContain('password: ***')
    expect(text).not.toContain('sup3rsecret')
  })

  test('reports the empty-config case gracefully', async () => {
    const { app } = makeApp() // no config.cache
    const env = buildCtx(app)
    const exit = await new CacheList().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No `config.cache` entry')
  })
})

// ─── cache:forget ────────────────────────────────────────────────────────

describe('cache:forget', () => {
  test('removes an existing key', async () => {
    const { app, cache } = makeApp({ driver: 'memory' })
    await cache.put('answer', 42)
    const env = buildCtx(app)
    const exit = await new CacheForget().handle(env.ctx(['answer']))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Forgot "answer"')
    expect(await cache.has('answer')).toBe(false)
  })

  test('reports when the key was not present', async () => {
    const { app } = makeApp({ driver: 'memory' })
    const env = buildCtx(app)
    const exit = await new CacheForget().handle(env.ctx(['absent']))
    expect(exit).toBe(0)
    const text = env.stdout.text() + env.stderr.text()
    expect(text).toMatch(/No entry for "absent"/i)
  })
})

// ─── cache:clear ─────────────────────────────────────────────────────────

describe('cache:clear', () => {
  test('--force flushes without prompting', async () => {
    const { app, cache } = makeApp({ driver: 'memory' })
    await cache.put('a', 1)
    await cache.put('b', 2)
    const env = buildCtx(app)
    const exit = await new CacheClear().handle(env.ctx([], { force: true }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Cache flushed')
    expect(await cache.has('a')).toBe(false)
    expect(await cache.has('b')).toBe(false)
  })
})
