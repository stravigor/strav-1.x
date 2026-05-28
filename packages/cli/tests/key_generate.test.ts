import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, type CommandContext, ConsoleOutput } from '@strav/kernel'
import { KeyGenerate } from '../src/key_generate.ts'

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

let tmpDir: string
let originalCwd: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `strav-key-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await import('node:fs/promises').then((m) => m.mkdir(tmpDir, { recursive: true }))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, { recursive: true, force: true })
})

function ctx(flags: Record<string, string | boolean> = {}): CommandContext {
  const out = new ConsoleOutput({
    stdout: new MemStream() as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  return { args: [], flags, out, app: new Application() }
}

describe('key:generate', () => {
  test('creates .env with APP_KEY= when no .env exists', async () => {
    const cmd = new KeyGenerate()
    const exit = await cmd.handle(ctx())
    expect(exit).toBe(0)
    const content = await readFile(join(tmpDir, '.env'), 'utf8')
    expect(content).toMatch(/^APP_KEY=[0-9a-f]{64}$/m)
  })

  test('appends to existing .env without APP_KEY', async () => {
    await writeFile(join(tmpDir, '.env'), 'APP_ENV=local\n')
    await new KeyGenerate().handle(ctx())
    const content = await readFile(join(tmpDir, '.env'), 'utf8')
    expect(content).toContain('APP_ENV=local')
    expect(content).toMatch(/APP_KEY=[0-9a-f]{64}/)
  })

  test('updates existing APP_KEY in place', async () => {
    await writeFile(join(tmpDir, '.env'), 'APP_KEY=oldvalue\nAPP_ENV=local\n')
    await new KeyGenerate().handle(ctx({ force: true }))
    const content = await readFile(join(tmpDir, '.env'), 'utf8')
    expect(content).not.toContain('oldvalue')
    expect(content).toMatch(/APP_KEY=[0-9a-f]{64}/)
    expect(content).toContain('APP_ENV=local')
  })

  test('warns and skips when APP_KEY already set (no --force)', async () => {
    await writeFile(join(tmpDir, '.env'), 'APP_KEY=abc\n')
    const stdout = new MemStream()
    const out = new ConsoleOutput({
      stdout: stdout as unknown as NodeJS.WritableStream,
      useColor: false,
    })
    const exit = await new KeyGenerate().handle({
      args: [],
      flags: {},
      out,
      app: new Application(),
    })
    expect(exit).toBe(0)
    expect(stdout.text()).toContain('already set')
    const content = await readFile(join(tmpDir, '.env'), 'utf8')
    expect(content).toContain('APP_KEY=abc') // unchanged
  })

  test('--show prints to stdout without writing .env', async () => {
    const stdout = new MemStream()
    const out = new ConsoleOutput({
      stdout: stdout as unknown as NodeJS.WritableStream,
      useColor: false,
    })
    const exit = await new KeyGenerate().handle({
      args: [],
      flags: { show: true },
      out,
      app: new Application(),
    })
    expect(exit).toBe(0)
    expect(stdout.text()).toMatch(/APP_KEY=[0-9a-f]{64}/)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(tmpDir, '.env'))).toBe(false)
  })
})
