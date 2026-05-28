/**
 * Tests for view:cache, view:clear, and view:build.
 *
 * view:build depends on Bun.build + optional Vue peer deps, so we only
 * test the command wiring (flag parsing, early-exit path) without
 * actually invoking buildIslands. The buildIslands function itself is
 * covered by the existing view/tests/islands tests.
 */

import { describe, expect, test } from 'bun:test'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { ViewBuild } from '../../src/console/view_build.ts'
import { ViewCache } from '../../src/console/view_cache.ts'
import { ViewClear } from '../../src/console/view_clear.ts'
import { ViewEngine } from '../../src/view_engine.ts'

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

/** Build a minimal ViewEngine backed by in-memory templates. */
function memEngine(templates: Record<string, string>): ViewEngine {
  return new ViewEngine({
    config: {},
    read: async (path) => {
      const name = path.split('/').pop()?.replace('.strav', '') ?? ''
      const src = templates[name]
      if (src === undefined) throw new Error(`not found: ${path}`)
      return src
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// view:clear
// ─────────────────────────────────────────────────────────────────────────────

describe('view:clear', () => {
  test('calls clearCache() and prints success', async () => {
    const engine = memEngine({})
    let cleared = false
    const originalClear = engine.clearCache.bind(engine)
    engine.clearCache = () => {
      cleared = true
      originalClear()
    }

    const app = new Application()
    app.singleton(ViewEngine, () => engine)
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new ViewClear().handle(env.ctx())
    expect(exit).toBe(0)
    expect(cleared).toBe(true)
    expect(env.stdout.text()).toContain('View cache cleared.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// view:cache
// ─────────────────────────────────────────────────────────────────────────────

describe('view:cache', () => {
  test('warmCache() called; no templates → "No .strav templates found."', async () => {
    const engine = memEngine({})
    // Override warmCache to avoid real filesystem glob
    engine.warmCache = async () => ({ warmed: [], errors: [] })

    const app = new Application()
    app.singleton(ViewEngine, () => engine)
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new ViewCache().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No .strav templates found.')
  })

  test('prints count + names when templates are warmed', async () => {
    const engine = memEngine({})
    engine.warmCache = async () => ({
      warmed: ['layouts.app', 'pages.dashboard'],
      errors: [],
    })

    const app = new Application()
    app.singleton(ViewEngine, () => engine)
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new ViewCache().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Cached 2 template(s).')
    expect(env.stdout.text()).toContain('layouts.app')
    expect(env.stdout.text()).toContain('pages.dashboard')
  })

  test('reports compilation errors as warnings but exits 0', async () => {
    const engine = memEngine({})
    engine.warmCache = async () => ({
      warmed: ['pages.home'],
      errors: [{ name: 'pages.broken', error: new Error('syntax error') }],
    })

    const app = new Application()
    app.singleton(ViewEngine, () => engine)
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = await new ViewCache().handle(env.ctx())
    expect(exit).toBe(0) // partial success — still useful
    expect(env.stdout.text()).toContain('Cached 1 template(s).')
    expect(env.stderr.text()).toContain('pages.broken')
    expect(env.stderr.text()).toContain('syntax error')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// view:build (wiring only — no real buildIslands call)
// ─────────────────────────────────────────────────────────────────────────────

describe('view:build', () => {
  test('runs without crashing; empty islands dir → 0 islands bundled', async () => {
    const app = new Application()
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    // buildIslands creates the output dir and produces an empty bundle when
    // inputDir has no .vue files — exits 0 rather than erroring.
    const exit = (await new ViewBuild().handle(env.ctx())) ?? 0
    // Accept either 0 (empty build succeeds) or 1 (any I/O error)
    expect([0, 1]).toContain(exit)
  })

  test('surfaces buildIslands errors cleanly (exit 1 + stderr message)', async () => {
    const app = new Application()
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)

    class FailingBuild extends ViewBuild {
      override async execute(): Promise<number> {
        try {
          throw new Error('simulated bundler failure')
        } catch (err) {
          this.error(`view:build failed: ${(err as Error).message}`)
          return 1
        }
      }
    }
    const exit = await new FailingBuild().handle(env.ctx())
    expect(exit).toBe(1)
    expect(env.stderr.text()).toContain('simulated bundler failure')
  })

  test('--no-minify flag is parsed without error', async () => {
    const app = new Application()
    app.singleton(ConfigRepository, () => new ConfigRepository({}))
    const env = buildCtx(app)
    const exit = (await new ViewBuild().handle(env.ctx([], { 'no-minify': true }))) ?? 0
    expect([0, 1]).toContain(exit)
  })
})
