/**
 * Unit tests for the migration commands. Each command goes through
 * `Command.handle(ctx)` (so argv binding + --help paths are exercised),
 * not raw `execute()` — that's the realistic dispatch path.
 *
 * The Application is constructed inline with the bindings the commands
 * resolve (`PostgresDatabase`, `MigrationRunner`, `ConfigRepository`).
 * No real Postgres — the `InMemoryDatabase` test double simulates the
 * tracking-table reads the runner emits.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { Migrate } from '../../src/console/migrate.ts'
import { MigrateRollback } from '../../src/console/migrate_rollback.ts'
import { MigrateStatus } from '../../src/console/migrate_status.ts'
import { PostgresDatabase } from '../../src/database.ts'
import { type Migration, MigrationRunner } from '../../src/index.ts'
import { InMemoryDatabase } from '../in_memory_database.ts'

class MemStream {
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

function mig(name: string, body: { up?: string; down?: string } = {}): Migration {
  return {
    name,
    async up(db) {
      if (body.up) await db.execute(body.up)
    },
    async down(db) {
      if (body.down) await db.execute(body.down)
    },
  }
}

function buildAppWith(...migrations: Migration[]): {
  app: Application
  db: InMemoryDatabase
  stdout: MemStream
  stderr: MemStream
  ctx: (args?: string[], flags?: Record<string, string | boolean>) => CommandContext
} {
  const db = new InMemoryDatabase()
  const app = new Application()
  // Bind the real PostgresDatabase key to the in-memory stub — the commands
  // only ever call query/queryOne/execute/transaction, all of which the
  // stub implements.
  app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
  const runner = new MigrationRunner(db)
  runner.registerAll(migrations)
  app.singleton(MigrationRunner, () => runner)
  // Stub ConfigRepository — resolveMigrationRunner reads database.migrationsPath
  // but never calls discover() against a real glob in these tests because
  // we pre-populate the runner via registerAll.
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
  const ctx = (
    args: string[] = [],
    flags: Record<string, string | boolean> = {},
  ): CommandContext => ({
    args,
    flags,
    out,
    app,
  })
  return { app, db, stdout, stderr, ctx }
}

let env: {
  app: Application
  db: InMemoryDatabase
  stdout: MemStream
  stderr: MemStream
  ctx: (args?: string[], flags?: Record<string, string | boolean>) => CommandContext
}
beforeEach(() => {
  env = buildAppWith(
    mig('20260101_a_first', { up: 'CREATE TABLE a ()', down: 'DROP TABLE a' }),
    mig('20260102_b_second', { up: 'CREATE TABLE b ()', down: 'DROP TABLE b' }),
  )
})

describe('migrate', () => {
  test('applies pending migrations and prints the batch number', async () => {
    const exit = await new Migrate().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Migrated 2 migration(s) — batch 1.')
    expect(env.stdout.text()).toContain('20260101_a_first')
    expect(env.stdout.text()).toContain('20260102_b_second')
    expect(env.db.appliedNames()).toEqual(['20260101_a_first', '20260102_b_second'])
  })

  test('no-op when DB is in sync prints "Nothing to migrate."', async () => {
    await new Migrate().handle(env.ctx())
    env.stdout.chunks.length = 0
    const exit = await new Migrate().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Nothing to migrate.')
  })
})

describe('migrate:rollback', () => {
  test('default --batch=1 rolls back the most recent batch', async () => {
    await new Migrate().handle(env.ctx())
    env.stdout.chunks.length = 0

    const exit = await new MigrateRollback().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Rolled back batch 1')
    expect(env.db.appliedNames()).toEqual([])
  })

  test('--batch=2 rolls back two batches', async () => {
    // First batch
    await new Migrate().handle(env.ctx())
    // Add a third migration → second batch
    const runner = env.app.resolve(MigrationRunner)
    runner.register(mig('20260103_c_third', { up: 'CREATE TABLE c ()', down: 'DROP TABLE c' }))
    await new Migrate().handle(env.ctx())
    env.stdout.chunks.length = 0

    const exit = await new MigrateRollback().handle(env.ctx([], { batch: '2' }))
    expect(exit).toBe(0)
    expect(env.db.appliedNames()).toEqual([])
  })

  test('--batch=all keeps rolling back until empty', async () => {
    await new Migrate().handle(env.ctx())
    const runner = env.app.resolve(MigrationRunner)
    runner.register(mig('20260103_c_third', { up: 'CREATE TABLE c ()', down: 'DROP TABLE c' }))
    await new Migrate().handle(env.ctx())
    env.stdout.chunks.length = 0

    const exit = await new MigrateRollback().handle(env.ctx([], { batch: 'all' }))
    expect(exit).toBe(0)
    expect(env.db.appliedNames()).toEqual([])
  })

  test('"Nothing to roll back." when no migrations are applied', async () => {
    const exit = await new MigrateRollback().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Nothing to roll back.')
  })

  test('--batch=not-a-number → exit 2 + UsageError message', async () => {
    const exit = await new MigrateRollback().handle(env.ctx([], { batch: 'oops' }))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('--batch must be a positive integer or "all"')
  })
})

describe('migrate:status', () => {
  test('prints a table with applied + pending rows', async () => {
    // Apply only the first migration.
    const runner = env.app.resolve(MigrationRunner)
    // Reset to one applied: simulate by running migrate then registering a 3rd unapplied one.
    await runner.migrate()
    runner.register(mig('20260103_c_third'))
    env.stdout.chunks.length = 0

    const exit = await new MigrateStatus().handle(env.ctx())
    expect(exit).toBe(0)
    const text = env.stdout.text()
    expect(text).toMatch(/Name\s+Status\s+Batch\s+Applied at/)
    expect(text).toContain('20260101_a_first')
    expect(text).toContain('applied')
    expect(text).toContain('20260103_c_third')
    expect(text).toContain('pending')
  })

  test('"No migrations registered." when both lists are empty', async () => {
    const empty = buildAppWith()
    const exit = await new MigrateStatus().handle(empty.ctx())
    expect(exit).toBe(0)
    expect(empty.stdout.text()).toContain('No migrations registered.')
  })
})
