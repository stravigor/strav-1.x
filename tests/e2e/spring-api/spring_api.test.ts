/**
 * E2E smoke for `@strav/spring` slice A.
 *
 * The whole `tests/e2e/spring-api/` package is a committed copy of what
 * `bunx @strav/spring my-app --api --db spring_smoke` produces (with
 * `workspace:*` deps so the local @strav/* packages resolve in this
 * monorepo). These tests prove that the scaffolded shape really boots —
 * decisions like "AppProvider lists `dependencies = ['http']` so the router
 * is bound before `register()` runs" only show up when you actually run the
 * binary, not from the scaffold's file-tree assertions.
 *
 * Companion in-process check: `tests/feature/healthz.test.ts` calls
 * `HttpKernel.handle` directly. This file spawns the real `bin/strav.ts`
 * subprocess.
 */

import { describe, expect, test } from 'bun:test'

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

describe('spring --api scaffolded app boots', () => {
  test('`bun strav` (no args) lists the registered commands, including serve', async () => {
    const result = await runStrav([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Available commands:')
    expect(result.stdout).toContain('serve')
  })

  test('unknown command exits non-zero with a stderr message', async () => {
    const result = await runStrav(['this-command-does-not-exist'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
