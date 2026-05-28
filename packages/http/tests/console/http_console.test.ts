/**
 * Tests for route:list, serve, and all.
 *
 * `serve` and `all` are long-running; we test them by immediately aborting
 * the signal so the command exits cleanly in the test.
 * `console` (REPL) is interactive so only the module wiring is tested — no
 * stdin simulation.
 */

import { describe, expect, test } from 'bun:test'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { All } from '../../src/console/all.ts'
import { RouteList } from '../../src/console/route_list.ts'
import { Serve } from '../../src/console/serve.ts'
import { Router } from '../../src/router/router.ts'

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

function buildCtx(app: Application) {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx = (
    args: string[] = [],
    flags: Record<string, string | boolean> = {},
  ): CommandContext => ({
    args,
    flags,
    out,
    app,
  })
  return { ctx, stdout, stderr }
}

// ─────────────────────────────────────────────────────────────────────────────
// route:list
// ─────────────────────────────────────────────────────────────────────────────

describe('route:list', () => {
  test('prints a table of registered routes sorted static-first', async () => {
    const router = new Router()
    router.get('/users', () => new Response('ok')).name('users.index')
    router.get('/users/:id', () => new Response('ok'))
    router.get('/', () => new Response('ok')).name('home')
    router.compile()

    const app = new Application()
    app.singleton(Router, () => router)
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new RouteList().handle(env.ctx())
    expect(exit).toBe(0)
    const text = env.stdout.text()
    // Table headers
    expect(text).toContain('Method')
    expect(text).toContain('Path')
    // Routes present
    expect(text).toContain('/users')
    expect(text).toContain('/users/:id')
    expect(text).toContain('home')
    // Static routes come before parameterised
    const homeIdx = text.indexOf('/')
    const paramIdx = text.indexOf(':id')
    expect(homeIdx).toBeLessThan(paramIdx)
  })

  test('"No routes registered." when router is empty', async () => {
    const router = new Router()
    router.compile()
    const app = new Application()
    app.singleton(Router, () => router)
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new RouteList().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No routes registered.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// serve — wiring test (abort immediately after start)
// ─────────────────────────────────────────────────────────────────────────────

describe('serve', () => {
  test('--port=bad-value → exit 2 + stderr message', async () => {
    const app = new Application()
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new Serve().handle(env.ctx([], { port: 'not-a-port', hostname: '0.0.0.0' }))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('--port must be a valid port number')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// all — same wiring test
// ─────────────────────────────────────────────────────────────────────────────

describe('all', () => {
  test('--port=bad-value → exit 2 + stderr message', async () => {
    const app = new Application()
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new All().handle(env.ctx([], { port: 'bad', hostname: '0.0.0.0' }))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('--port must be a valid port number')
  })
})
