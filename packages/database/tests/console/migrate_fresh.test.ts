/**
 * `migrate:fresh` tests — covers the APP_ENV guard, the --force bypass of
 * the confirm prompt, and the drop+migrate sequence. Confirm-prompt-driven
 * path isn't exercised here (stdin stubbing is out of scope for this
 * slice's tests — covered indirectly by the e2e migrate suite).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { MigrateFresh } from '../../src/console/migrate_fresh.ts'
import { PostgresDatabase } from '../../src/database.ts'
import { type Migration, MigrationRunner } from '../../src/index.ts'
import { InMemoryDatabase } from '../in_memory_database.ts'

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

function mig(name: string, up = 'CREATE TABLE x ()'): Migration {
  return {
    name,
    async up(db) {
      await db.execute(up)
    },
    async down(db) {
      await db.execute('DROP TABLE x')
    },
  }
}

function buildApp(): {
  app: Application
  db: InMemoryDatabase
  stdout: MemStream
  stderr: MemStream
  ctx: (flags?: Record<string, string | boolean>) => CommandContext
} {
  const db = new InMemoryDatabase()
  const app = new Application()
  app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
  const runner = new MigrationRunner(db)
  runner.register(mig('20260101_create_x'))
  app.singleton(MigrationRunner, () => runner)
  app.singleton(
    ConfigRepository,
    () => new ConfigRepository({ database: { migrationsPath: 'nope' } }),
  )

  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx = (flags: Record<string, string | boolean> = {}): CommandContext => ({
    args: [],
    flags: { force: true, ...flags }, // tests use --force to skip the confirm prompt
    out,
    app,
  })
  return { app, db, stdout, stderr, ctx }
}

let originalEnv: string | undefined

beforeEach(() => {
  originalEnv = process.env.APP_ENV
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.APP_ENV
  else process.env.APP_ENV = originalEnv
})

describe('migrate:fresh — APP_ENV guard', () => {
  test('refuses to run when APP_ENV=production', async () => {
    process.env.APP_ENV = 'production'
    const env = buildApp()
    const exit = await new MigrateFresh().handle(env.ctx())
    expect(exit).toBe(64) // ExitCode.ConfigError
    expect(env.stderr.text()).toContain('refuses to run when APP_ENV=production')
  })

  test('refuses when APP_ENV=staging', async () => {
    process.env.APP_ENV = 'staging'
    const env = buildApp()
    const exit = await new MigrateFresh().handle(env.ctx())
    expect(exit).toBe(64)
  })

  test('runs when APP_ENV=local', async () => {
    process.env.APP_ENV = 'local'
    const env = buildApp()
    const exit = await new MigrateFresh().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.db.executedSql).toContain('DROP SCHEMA public CASCADE')
    expect(env.db.executedSql).toContain('CREATE SCHEMA public')
    // Then migrate runs.
    expect(env.db.appliedNames()).toEqual(['20260101_create_x'])
  })

  test('runs when APP_ENV=testing', async () => {
    process.env.APP_ENV = 'testing'
    const env = buildApp()
    const exit = await new MigrateFresh().handle(env.ctx())
    expect(exit).toBe(0)
  })
})
