/**
 * M1 end-to-end smoke.
 *
 * Spawns the real `bin/strav.ts` in a subprocess so we exercise:
 *   - tsconfig discovery (decorator metadata emit must be on)
 *   - workspace resolution of `@strav/kernel`
 *   - module loading order (`reflect-metadata` pulled in by the kernel)
 *   - Application boot via `createApp()` → ConfigProvider register + boot
 *   - ConsoleKernel.run dispatching the command class
 *   - Container resolution of `HelloCommand` with its `ConfigRepository` dep
 *   - ConfigRepository.get reading from the (already frozen) config
 *   - ConsoleOutput writing to the real process stdout
 *
 * Each test starts a fresh subprocess — exit codes and stream contents come
 * from the OS, not from in-process state.
 */

import { describe, expect, test } from 'bun:test'

const BIN = 'bin/strav.ts'

async function runStrav(args: readonly string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    // Insulate from the parent test process's APP_ENV so behaviour is reproducible.
    env: { ...process.env, APP_ENV: 'testing' },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

describe('M1 e2e smoke', () => {
  test('hello command boots the app, resolves deps, prints to stdout, exit 0', async () => {
    const result = await runStrav(['hello'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello world from strav-m1-boot\n')
    expect(result.stderr).toBe('')
  })

  test('positional args are passed through to the command', async () => {
    const result = await runStrav(['hello', 'alice'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello alice from strav-m1-boot\n')
    expect(result.stderr).toBe('')
  })

  test('empty argv prints the command list (exit 0, stdout only)', async () => {
    const result = await runStrav([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Available commands:')
    expect(result.stdout).toContain('hello')
    expect(result.stdout).toContain('Print a greeting from the configured app')
    expect(result.stderr).toBe('')
  })

  test('unknown command exits 1 and writes the error to stderr', async () => {
    const result = await runStrav(['nope'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown command "nope"')
  })

  test('--help and -h both print the list', async () => {
    const [help, h] = await Promise.all([runStrav(['--help']), runStrav(['-h'])])
    expect(help.exitCode).toBe(0)
    expect(h.exitCode).toBe(0)
    expect(help.stdout).toContain('Available commands:')
    expect(h.stdout).toContain('Available commands:')
  })

  test('APP_NAME env var feeds through into ConfigRepository and the command output', async () => {
    const proc = Bun.spawn(['bun', BIN, 'hello'], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, APP_ENV: 'testing', APP_NAME: 'custom-app-name' },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(stdout).toBe('hello world from custom-app-name\n')
  })
})
