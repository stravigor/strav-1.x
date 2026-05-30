/**
 * E2E smoke for `@strav/spring` slice B (`--web` template).
 *
 * The whole `tests/e2e/spring-web/` package is a committed copy of what
 * `bunx @strav/spring my-blog --web --db spring_web` produces (with
 * `workspace:*` deps so local @strav/* packages resolve in this monorepo).
 *
 * Two layers of proof:
 *   1. Subprocess `bun strav` — the dispatcher discovers ViewConsoleProvider
 *      commands (`view:build`, etc.) alongside the http ones.
 *   2. In-process boot — HttpKernel + ViewProvider's pages auto-router
 *      render `resources/views/pages/index.strav` for GET /, including the
 *      `@island('Counter', ...)` placeholder markup.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HttpKernel } from '@strav/http'
import { createApp } from './bootstrap/app.ts'
import { providers } from './bootstrap/providers.ts'

// ViewProvider's pages auto-router resolves `resources/views/pages` relative
// to process.cwd(). When `bun test` runs from the workspace root the path
// misses; chdir into the fixture so the scaffolded app sees its own layout.
const ORIGINAL_CWD = process.cwd()
beforeAll(() => process.chdir(import.meta.dir))
afterAll(() => process.chdir(ORIGINAL_CWD))

async function runStrav(args: readonly string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn(['bun', 'bin/strav.ts', ...args], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, APP_ENV: 'testing', LOG_LEVEL: 'error' },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

describe('spring --web scaffolded app boots', () => {
  test('`bun strav` (no args) lists serve + view:build', async () => {
    const result = await runStrav([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('serve')
    expect(result.stdout).toContain('view:build')
  })

  test('GET / renders the auto-routed index.strav page with the Counter island', async () => {
    const app = createApp()
    app.useProviders(providers())
    await app.start()

    const kernel = app.resolve(HttpKernel)
    const res = await kernel.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Welcome to spring-web')
    expect(html).toContain('data-island="Counter"')

    await app.shutdown()
  })

  test('GET /healthz still answers — registerApiRoutes is wired alongside web', async () => {
    const app = createApp()
    app.useProviders(providers())
    await app.start()

    const kernel = app.resolve(HttpKernel)
    const res = await kernel.handle(new Request('http://localhost/healthz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await app.shutdown()
  })

  test('GET /hello.txt is served from public/ via config.http.publicDir', async () => {
    const app = createApp()
    app.useProviders(providers())
    await app.start()

    const kernel = app.resolve(HttpKernel)
    const res = await kernel.handle(new Request('http://localhost/hello.txt'))
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('static asset served by HttpKernel')

    await app.shutdown()
  })
})
