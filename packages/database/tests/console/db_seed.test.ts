import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, type CommandContext, ConfigRepository, ConsoleOutput } from '@strav/kernel'
import { DbSeed } from '../../src/console/db_seed.ts'
import { PostgresDatabase } from '../../src/database.ts'
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

let tmpDir: string
let originalCwd: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `strav-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmpDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, { recursive: true, force: true })
})

function buildEnv() {
  const db = new InMemoryDatabase()
  const app = new Application()
  app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
  app.singleton(ConfigRepository, () => new ConfigRepository({}))
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx = (flags: Record<string, string | boolean> = {}): CommandContext => ({
    args: [],
    flags,
    out,
    app,
  })
  return { db, ctx, stdout, stderr }
}

async function writeSeeder(name: string, body: string) {
  const dir = join(tmpDir, 'database/seeders')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.ts`), body, 'utf8')
}

describe('db:seed', () => {
  test('"No seeders found." when directory is empty', async () => {
    const env = buildEnv()
    const exit = await new DbSeed().handle(env.ctx({ path: 'database/seeders/**/*.ts' }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No seeders found.')
  })

  test('runs discovered seeders and prints success', async () => {
    await writeSeeder(
      'user_seeder',
      `export class UserSeeder {
  async run(db) {
    await db.execute('INSERT INTO users VALUES (1)')
  }
}`,
    )
    const env = buildEnv()
    const exit = await new DbSeed().handle(env.ctx({ path: 'database/seeders/**/*.ts' }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('UserSeeder')
    expect(env.db.executedSql).toContain('INSERT INTO users VALUES (1)')
  })

  test('--seeder=Name filters to one seeder', async () => {
    await writeSeeder(
      'a_seeder',
      `export class ASeeder { async run(db) { await db.execute('A') } }`,
    )
    await writeSeeder(
      'b_seeder',
      `export class BSeeder { async run(db) { await db.execute('B') } }`,
    )
    const env = buildEnv()
    const exit = await new DbSeed().handle(
      env.ctx({ path: 'database/seeders/**/*.ts', seeder: 'ASeeder' }),
    )
    expect(exit).toBe(0)
    expect(env.db.executedSql).toContain('A')
    expect(env.db.executedSql).not.toContain('B')
  })

  test('--seeder=Unknown → exit 65 + error message', async () => {
    await writeSeeder('a_seeder', `export class ASeeder { async run() {} }`)
    const env = buildEnv()
    const exit = await new DbSeed().handle(
      env.ctx({ path: 'database/seeders/**/*.ts', seeder: 'Nonexistent' }),
    )
    expect(exit).toBe(65)
    expect(env.stderr.text()).toContain('"Nonexistent" not found')
  })
})
