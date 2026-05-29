/**
 * Tests for `config:show` + `config:list` — the two read-only config
 * introspection commands in `UtilConsoleProvider`. Builds a fresh
 * Application with `ConfigRepository` bound to a known config object so
 * the assertions don't depend on the host environment.
 */

import { describe, expect, test } from 'bun:test'
import {
  Application,
  type CommandContext,
  ConfigRepository,
  ConsoleOutput,
} from '@strav/kernel'
import { ConfigList } from '../src/config_list.ts'
import { ConfigShow } from '../src/config_show.ts'
import { ExitCode } from '../src/exit_codes.ts'

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

function appWithConfig(data: Record<string, unknown>): Application {
  const app = new Application()
  app.singleton(ConfigRepository, () => new ConfigRepository(data))
  return app
}

function ctx(
  app: Application,
  args: string[] = [],
  flags: Record<string, string | boolean> = {},
): { context: CommandContext; out: MemStream; err: MemStream } {
  const out = new MemStream()
  const err = new MemStream()
  const consoleOut = new ConsoleOutput({
    stdout: out as unknown as NodeJS.WritableStream,
    stderr: err as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  return {
    context: { args, flags, out: consoleOut, app },
    out,
    err,
  }
}

describe('config:show', () => {
  test('prints a scalar value when the key resolves', async () => {
    const app = appWithConfig({ app: { url: 'https://example.test', port: 3000 } })
    const cmd = new ConfigShow()
    const { context, out } = ctx(app, ['app.url'])
    const exit = await cmd.handle(context)
    expect(exit).toBe(ExitCode.Success)
    expect(out.text()).toMatch(/https:\/\/example\.test/)
  })

  test('coerces numbers / booleans via String()', async () => {
    const app = appWithConfig({ app: { port: 3000, debug: true } })
    const cmd = new ConfigShow()
    const { context, out } = ctx(app, ['app.port'])
    await cmd.handle(context)
    expect(out.text().trim()).toBe('3000')
  })

  test('pretty-prints objects as JSON', async () => {
    const app = appWithConfig({ app: { url: 'https://x', port: 3000 } })
    const cmd = new ConfigShow()
    const { context, out } = ctx(app, ['app'])
    await cmd.handle(context)
    const printed = out.text().trim()
    expect(printed.startsWith('{')).toBe(true)
    expect(JSON.parse(printed)).toEqual({ url: 'https://x', port: 3000 })
  })

  test('--json prints compact JSON for any value', async () => {
    const app = appWithConfig({ app: { url: 'https://x' } })
    const cmd = new ConfigShow()
    const { context, out } = ctx(app, ['app.url'], { json: true })
    await cmd.handle(context)
    expect(out.text().trim()).toBe('"https://x"')
  })

  test('missing key exits 65 with an error', async () => {
    const app = appWithConfig({ app: { url: 'https://x' } })
    const cmd = new ConfigShow()
    const { context, err } = ctx(app, ['auth.default'])
    const exit = await cmd.handle(context)
    expect(exit).toBe(ExitCode.DataError)
    expect(err.text()).toMatch(/auth\.default/)
  })
})

describe('config:list', () => {
  test('prints namespaces sorted alphabetically', async () => {
    const app = appWithConfig({
      database: { url: 'postgres://x' },
      app: { url: 'https://x' },
      auth: { default: 'session' },
    })
    const cmd = new ConfigList()
    const { context, out } = ctx(app)
    const exit = await cmd.handle(context)
    expect(exit).toBe(ExitCode.Success)
    const lines = out
      .text()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(lines.slice(0, 3)).toEqual(['app', 'auth', 'database'])
  })

  test('marks empty namespaces with "(empty)"', async () => {
    const app = appWithConfig({ app: { url: 'https://x' }, plugins: {} })
    const cmd = new ConfigList()
    const { context, out } = ctx(app)
    await cmd.handle(context)
    expect(out.text()).toMatch(/plugins \(empty\)/)
  })

  test('null / undefined values are treated as empty', async () => {
    const app = appWithConfig({ app: { url: 'https://x' }, optional: null })
    const cmd = new ConfigList()
    const { context, out } = ctx(app)
    await cmd.handle(context)
    expect(out.text()).toMatch(/optional \(empty\)/)
  })

  test('prints "No config namespaces are loaded." when empty', async () => {
    const app = appWithConfig({})
    const cmd = new ConfigList()
    const { context, out } = ctx(app)
    const exit = await cmd.handle(context)
    expect(exit).toBe(ExitCode.Success)
    expect(out.text()).toMatch(/No config namespaces/)
  })
})

