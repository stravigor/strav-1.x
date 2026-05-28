/**
 * `migrate:generate` tests — exercise the dry-run path (no file IO) and
 * the --message / --allow-drop / --allow-alter flag plumbing. End-to-end
 * file emission belongs with the e2e migrate suite (needs a real Postgres
 * to read information_schema).
 */

import { describe, expect, test } from 'bun:test'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { MigrateGenerate } from '../../src/console/migrate_generate.ts'
import { type DatabaseExecutor, PostgresDatabase } from '../../src/database.ts'
import { Archetype, defineSchema, MigrationRunner, SchemaRegistry } from '../../src/index.ts'

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

/** Database stub returning a fixed `information_schema` snapshot. */
class FakeDb implements DatabaseExecutor {
  constructor(private readonly rows: unknown[]) {}
  async query<T = Record<string, unknown>>(): Promise<T[]> {
    return this.rows as T[]
  }
  async queryOne<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.rows[0] as T | undefined) ?? null
  }
  async execute(): Promise<number> {
    return 0
  }
}

function build(rows: unknown[], schemas: ReturnType<typeof defineSchema>[]) {
  const db = new FakeDb(rows)
  const app = new Application()
  app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
  app.singleton(SchemaRegistry, () => new SchemaRegistry().registerAll(schemas))
  app.singleton(MigrationRunner, () => new MigrationRunner(db as unknown as PostgresDatabase))
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
  const ctx = (flags: Record<string, string | boolean>): CommandContext => ({
    args: [],
    flags,
    out,
    app,
  })
  return { app, stdout, stderr, ctx }
}

describe('migrate:generate', () => {
  test('--message is required', async () => {
    const env = build([], [])
    const exit = await new MigrateGenerate().handle(env.ctx({}))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('--message')
  })

  test('empty DB + one schema → dry-run prints a migration file with CREATE TABLE', async () => {
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').unique()
    })
    const env = build([], [user])
    const exit = await new MigrateGenerate().handle(
      env.ctx({ message: 'add users', 'dry-run': true }),
    )
    expect(exit).toBe(0)
    const text = env.stdout.text()
    expect(text).toContain('database/migrations/')
    expect(text).toContain('_add_users.ts')
    expect(text).toContain('export const migration: Migration')
    expect(text).toContain('CREATE TABLE "user"')
    expect(text).toContain('DROP TABLE IF EXISTS "user"')
  })

  test('DB already in sync → "No diff" message, no file written', async () => {
    // The FakeDb returns rows for `user(id char(26) NOT NULL)`; the schema
    // matches exactly so the diff is empty.
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const env = build(
      [
        {
          table_name: 'user',
          column_name: 'id',
          data_type: 'character',
          character_maximum_length: 26,
          is_nullable: 'NO',
          column_default: null,
        },
      ],
      [user],
    )
    const exit = await new MigrateGenerate().handle(env.ctx({ message: 'noop', 'dry-run': true }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No diff')
  })

  test('SchemaRegistry not bound → ConfigError thrown', async () => {
    const db = new FakeDb([])
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    app.singleton(MigrationRunner, () => new MigrationRunner(db as unknown as PostgresDatabase))
    app.singleton(
      ConfigRepository,
      () => new ConfigRepository({ database: { migrationsPath: 'nope' } }),
    )
    const stdout = new MemStream()
    const out = new ConsoleOutput({
      stdout: stdout as unknown as NodeJS.WritableStream,
      useColor: false,
    })
    // ConfigError bubbles out of handle() (only UsageError is caught and
    // mapped to exit 2). The kernel's ConsoleKernel.handle() would surface
    // this as exit 1; tested directly, we see the throw.
    await expect(
      new MigrateGenerate().handle({ args: [], flags: { message: 'whatever' }, out, app }),
    ).rejects.toThrow(/SchemaRegistry is not bound/)
  })
})
