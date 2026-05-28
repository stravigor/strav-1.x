/**
 * Tests for make:* scaffold commands.
 *
 * Each test uses a real tmp directory so we exercise the actual fs write.
 * All make:* commands set static providers = [] so they don't need a booted app.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, type CommandContext, ConsoleOutput } from '@strav/kernel'
import { MakeController } from '../src/make/make_controller.ts'
import { MakeFactory } from '../src/make/make_factory.ts'
import { MakeMigration } from '../src/make/make_migration.ts'
import { MakeModel } from '../src/make/make_model.ts'
import { MakeProvider } from '../src/make/make_provider.ts'
import { MakeTest } from '../src/make/make_test.ts'

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
  tmpDir = join(tmpdir(), `strav-make-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmpDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, { recursive: true, force: true })
})

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

function app() {
  return new Application()
}

// ─────────────────────────────────────────────────────────────────────────────
// make:controller
// ─────────────────────────────────────────────────────────────────────────────

describe('make:controller', () => {
  test('writes app/http/controllers/<snake>.ts with PascalCaseController class', async () => {
    const env = buildCtx(app())
    const exit = await new MakeController().handle(env.ctx(['UserController']))
    expect(exit).toBe(0)
    const content = await readFile(join(tmpDir, 'app/http/controllers/user_controller.ts'), 'utf8')
    expect(content).toContain('export class UserController')
    expect(content).toContain('@strav/http')
  })

  test('skips without error when file already exists', async () => {
    const env = buildCtx(app())
    await new MakeController().handle(env.ctx(['User']))
    env.stdout.chunks.length = 0
    env.stderr.chunks.length = 0
    const exit = await new MakeController().handle(env.ctx(['User']))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('already exists')
  })

  test('exits UsageError when name is missing', async () => {
    const env = buildCtx(app())
    const exit = await new MakeController().handle(env.ctx([]))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('missing argument')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// make:model (model_generator)
// ─────────────────────────────────────────────────────────────────────────────

describe('make:model', () => {
  test('writes Model + Repository + Factory stubs', async () => {
    const env = buildCtx(app())
    const exit = await new MakeModel().handle(env.ctx(['Lead']))
    expect(exit).toBe(0)
    const model = await readFile(join(tmpDir, 'app/models/lead.ts'), 'utf8')
    const repo = await readFile(join(tmpDir, 'app/repositories/lead_repository.ts'), 'utf8')
    const factory = await readFile(join(tmpDir, 'database/factories/lead_factory.ts'), 'utf8')
    expect(model).toContain('export class Lead extends Model')
    expect(repo).toContain('export class LeadRepository extends Repository<Lead>')
    expect(factory).toContain('export function leadFactory')
    expect(env.stdout.text()).toContain('lead.ts')
    expect(env.stdout.text()).toContain('lead_repository.ts')
    expect(env.stdout.text()).toContain('lead_factory.ts')
  })

  test('skips existing files individually', async () => {
    await new MakeModel().handle(buildCtx(app()).ctx(['Post']))
    const { stdout, ctx } = buildCtx(app())
    await new MakeModel().handle(ctx(['Post']))
    expect(stdout.text()).toContain('already exists')
    // All three skipped
    expect(stdout.text().match(/already exists/g)?.length).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// make:migration
// ─────────────────────────────────────────────────────────────────────────────

describe('make:migration', () => {
  test('creates database/migrations/<timestamp>_<slug>.ts', async () => {
    const env = buildCtx(app())
    const exit = await new MakeMigration().handle(env.ctx([], { message: 'create users' }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('_create_users.ts')
    // File contains the migration shape
    const files = await import('node:fs').then((m) =>
      m.readdirSync(join(tmpDir, 'database/migrations')),
    )
    expect(files.length).toBe(1)
    const content = await readFile(join(tmpDir, 'database/migrations', files[0] as string), 'utf8')
    expect(content).toContain('export const migration: Migration')
  })

  test('--message is required → exit 2', async () => {
    const env = buildCtx(app())
    const exit = await new MakeMigration().handle(env.ctx())
    expect(exit).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// make:provider
// ─────────────────────────────────────────────────────────────────────────────

describe('make:provider', () => {
  test('writes app/providers/<snake>.ts with ServiceProvider stub', async () => {
    const env = buildCtx(app())
    const exit = await new MakeProvider().handle(env.ctx(['AnalyticsProvider']))
    expect(exit).toBe(0)
    const content = await readFile(join(tmpDir, 'app/providers/analytics_provider.ts'), 'utf8')
    expect(content).toContain('extends ServiceProvider')
    expect(content).toContain("name = 'analytics'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// make:factory
// ─────────────────────────────────────────────────────────────────────────────

describe('make:factory', () => {
  test('writes database/factories/<name>_factory.ts', async () => {
    const env = buildCtx(app())
    const exit = await new MakeFactory().handle(env.ctx(['User']))
    expect(exit).toBe(0)
    const content = await readFile(join(tmpDir, 'database/factories/user_factory.ts'), 'utf8')
    expect(content).toContain('export function userFactory')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// make:test
// ─────────────────────────────────────────────────────────────────────────────

describe('make:test', () => {
  test('writes tests/feature/<snake>.test.ts', async () => {
    const env = buildCtx(app())
    const exit = await new MakeTest().handle(env.ctx(['UserRegistration']))
    expect(exit).toBe(0)
    const content = await readFile(join(tmpDir, 'tests/feature/user_registration.test.ts'), 'utf8')
    expect(content).toContain("from 'bun:test'")
    expect(content).toContain('user registration')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// naming helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('naming helpers', async () => {
  const { pascal, snake, camel } = await import('../src/make_command.ts')
  test('pascal: kebab / snake / already pascal all work', () => {
    expect(pascal('my-foo')).toBe('MyFoo')
    expect(pascal('my_foo')).toBe('MyFoo')
    expect(pascal('MyFoo')).toBe('MyFoo')
  })
  test('snake: PascalCase → snake_case', () => {
    expect(snake('MyFoo')).toBe('my_foo')
    expect(snake('myFoo')).toBe('my_foo')
  })
  test('camel: MyFoo → myFoo', () => {
    expect(camel('MyFoo')).toBe('myFoo')
    expect(camel('my_foo')).toBe('myFoo')
  })
})
