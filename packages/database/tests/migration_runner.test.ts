import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Migration, MigrationRunner } from '../src/index.ts'
import { InMemoryDatabase } from './in_memory_database.ts'

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

let db: InMemoryDatabase
beforeEach(() => {
  db = new InMemoryDatabase()
})

describe('MigrationRunner — migrate', () => {
  test('applies pending migrations in alphabetical order', async () => {
    const runner = new MigrationRunner(db)
    runner.registerAll([
      mig('20260101_b_second', { up: 'CREATE TABLE b ()' }),
      mig('20260101_a_first', { up: 'CREATE TABLE a ()' }),
    ])

    const result = await runner.migrate()
    expect(result.applied).toEqual(['20260101_a_first', '20260101_b_second'])
    expect(result.batch).toBe(1)
    expect(db.appliedNames()).toEqual(['20260101_a_first', '20260101_b_second'])
    // Migration bodies ran in order — assert the recorded DDL.
    const ddl = db.executedSql.filter((s) => s.startsWith('CREATE TABLE'))
    expect(ddl).toEqual(['CREATE TABLE a ()', 'CREATE TABLE b ()'])
  })

  test('a second migrate() applies only what is new and bumps the batch', async () => {
    const runner = new MigrationRunner(db)
    runner.register(mig('a', { up: 'CREATE TABLE a ()' }))
    let result = await runner.migrate()
    expect(result.applied).toEqual(['a'])
    expect(result.batch).toBe(1)

    // Register a new migration and run again — batch increments, "a" is skipped.
    runner.register(mig('b', { up: 'CREATE TABLE b ()' }))
    result = await runner.migrate()
    expect(result.applied).toEqual(['b'])
    expect(result.batch).toBe(2)
  })

  test('no pending migrations → empty applied list', async () => {
    const runner = new MigrationRunner(db)
    runner.register(mig('a'))
    await runner.migrate()
    const result = await runner.migrate()
    expect(result.applied).toEqual([])
  })

  test('register() throws on duplicate name', () => {
    const runner = new MigrationRunner(db)
    runner.register(mig('a'))
    expect(() => runner.register(mig('a'))).toThrow(/already registered/)
  })
})

describe('MigrationRunner — rollback', () => {
  test('rolls back the most recent batch in reverse order', async () => {
    const runner = new MigrationRunner(db)
    runner.registerAll([
      mig('a', { up: 'CREATE TABLE a ()', down: 'DROP TABLE a' }),
      mig('b', { up: 'CREATE TABLE b ()', down: 'DROP TABLE b' }),
    ])
    await runner.migrate()
    const result = await runner.rollback()
    expect(result.rolled_back).toEqual(['b', 'a'])
    expect(result.batch).toBe(1)
    expect(db.appliedNames()).toEqual([])

    // The downs ran in reverse.
    const ddl = db.executedSql.filter((s) => s.startsWith('DROP TABLE'))
    expect(ddl).toEqual(['DROP TABLE b', 'DROP TABLE a'])
  })

  test('rollback only undoes the last batch, leaving earlier batches in place', async () => {
    const runner = new MigrationRunner(db)
    runner.register(mig('a', { up: 'CREATE TABLE a ()', down: 'DROP TABLE a' }))
    await runner.migrate() // batch 1: a

    runner.register(mig('b', { up: 'CREATE TABLE b ()', down: 'DROP TABLE b' }))
    await runner.migrate() // batch 2: b

    await runner.rollback() // undoes b only
    expect(db.appliedNames()).toEqual(['a'])
  })

  test('rollback with nothing applied returns batch 0', async () => {
    const runner = new MigrationRunner(db)
    const result = await runner.rollback()
    expect(result).toEqual({ rolled_back: [], batch: 0 })
  })

  test('rollback throws when an applied migration has no code registered', async () => {
    const runner = new MigrationRunner(db)
    runner.register(mig('a', { up: 'CREATE TABLE a ()', down: 'DROP TABLE a' }))
    await runner.migrate()

    // Build a new runner that doesn't know about "a".
    const next = new MigrationRunner(db)
    await expect(next.rollback()).rejects.toThrow(/not registered/)
  })
})

describe('MigrationRunner — status', () => {
  test('reports applied + pending', async () => {
    const runner = new MigrationRunner(db)
    runner.registerAll([mig('a'), mig('b'), mig('c')])
    await runner.migrate()
    runner.register(mig('d'))

    const status = await runner.status()
    expect(status.applied.map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(status.pending).toEqual(['d'])
  })

  test('pending list is empty when everything is applied', async () => {
    const runner = new MigrationRunner(db)
    runner.registerAll([mig('a'), mig('b')])
    await runner.migrate()
    const status = await runner.status()
    expect(status.pending).toEqual([])
  })
})

describe('MigrationRunner — list', () => {
  test('returns migrations sorted by name', () => {
    const runner = new MigrationRunner(db)
    runner.registerAll([mig('z'), mig('a'), mig('m')])
    expect(runner.list().map((m) => m.name)).toEqual(['a', 'm', 'z'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// discover
// ─────────────────────────────────────────────────────────────────────────────

describe('MigrationRunner — discover', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strav-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, { recursive: true })
  })

  async function writeMigrationFile(filename: string, content: string): Promise<void> {
    await writeFile(join(tempDir, filename), content, 'utf8')
  }

  test('discovers migration objects exported from a glob', async () => {
    await writeMigrationFile(
      '20260601_add_users.ts',
      `export const migration = {
         name: '20260601_add_users',
         async up(db) { await db.execute('CREATE TABLE users ()') },
         async down(db) { await db.execute('DROP TABLE users') },
       }`,
    )
    await writeMigrationFile(
      '20260602_add_posts.ts',
      `export const migration = {
         name: '20260602_add_posts',
         async up(db) { await db.execute('CREATE TABLE posts ()') },
         async down(db) { await db.execute('DROP TABLE posts') },
       }`,
    )

    const runner = new MigrationRunner(db)
    await runner.discover('*.ts', { cwd: tempDir })
    expect(runner.list().map((m) => m.name)).toEqual(['20260601_add_users', '20260602_add_posts'])

    await rm(tempDir, { recursive: true, force: true })
  })

  test('files without migration exports are silently skipped', async () => {
    await writeMigrationFile('helper.ts', `export function notAMigration() { return 42 }`)
    await writeMigrationFile(
      '20260601_real.ts',
      `export const migration = {
         name: '20260601_real',
         async up() {},
         async down() {},
       }`,
    )

    const runner = new MigrationRunner(db)
    await runner.discover('*.ts', { cwd: tempDir })
    expect(runner.list().map((m) => m.name)).toEqual(['20260601_real'])

    await rm(tempDir, { recursive: true, force: true })
  })

  test('re-discovering the same migration is idempotent', async () => {
    await writeMigrationFile(
      '20260601_x.ts',
      `export const migration = {
         name: '20260601_x',
         async up() {},
         async down() {},
       }`,
    )

    const runner = new MigrationRunner(db)
    await runner.discover('*.ts', { cwd: tempDir })
    await runner.discover('*.ts', { cwd: tempDir })
    expect(runner.list()).toHaveLength(1)

    await rm(tempDir, { recursive: true, force: true })
  })
})
