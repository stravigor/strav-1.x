import { describe, expect, test } from 'bun:test'
import { EventBus } from '@strav/kernel'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  defineSchema,
  emitRestoreById,
  emitSoftDeleteById,
  Model,
  type ModelClass,
  type PostgresDatabase,
  QueryBuilder,
  Repository,
  schemaHasSoftDelete,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + fakes
// ─────────────────────────────────────────────────────────────────────────────

function nonNull<T>(v: T | null | undefined, msg = 'expected non-null'): T {
  if (v === null || v === undefined) throw new Error(msg)
  return v
}

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.softDeletes()
  t.timestamps()
})

class User extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  deleted_at!: Date | null
  created_at!: Date
  updated_at!: Date
}

class UserRepository extends Repository<User> {
  static override readonly schema = userSchema
  static override readonly model: ModelClass = User as unknown as ModelClass
}

const hardSchema = defineSchema('event_log', Archetype.Event, (t) => {
  t.id()
  t.string('action')
  t.timestamp('created_at').default({ sql: 'now()' })
})

class EventLog extends Model {
  static override readonly schema = hardSchema
  id!: string
  action!: string
  created_at!: Date
}

class EventLogRepository extends Repository<EventLog> {
  static override readonly schema = hardSchema
  static override readonly model: ModelClass = EventLog as unknown as ModelClass
}

/** Tracks executor calls — distinguishes execute() (hard delete) vs queryOne() (soft delete / restore). */
class SpyDb implements Database {
  readonly executed: Array<{ sql: string; params: readonly unknown[] }> = []
  readonly queriedOne: Array<{ sql: string; params: readonly unknown[] }> = []
  readonly queried: Array<{ sql: string; params: readonly unknown[] }> = []
  /** Row returned from any RETURNING * call. */
  scriptedRow: Record<string, unknown> | null = null
  /** Rows returned from any non-RETURNING SELECT. */
  scriptedRows: Record<string, unknown>[] = []

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queried.push({ sql, params })
    return this.scriptedRows as T[]
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.queriedOne.push({ sql, params })
    return (this.scriptedRow as T | null) ?? null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.executed.push({ sql, params })
    return 1
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('SpyDb.raw not implemented')
  }
}

function makeUser(id = 'u-1', email = 'a@b.com', deletedAt: Date | null = null): User {
  const u = new User()
  u.id = id
  u.email = email
  u.deleted_at = deletedAt
  u.created_at = new Date()
  u.updated_at = new Date()
  return u
}

// ─────────────────────────────────────────────────────────────────────────────
// schemaHasSoftDelete + SQL emitters
// ─────────────────────────────────────────────────────────────────────────────

describe('schemaHasSoftDelete', () => {
  test('true when the schema declared t.softDeletes()', () => {
    expect(schemaHasSoftDelete(userSchema)).toBe(true)
  })
  test('false otherwise', () => {
    expect(schemaHasSoftDelete(hardSchema)).toBe(false)
  })
})

describe('emitSoftDeleteById', () => {
  test('emits UPDATE … SET deleted_at = now() WHERE id = $1 RETURNING *', () => {
    const { sql, params } = emitSoftDeleteById(userSchema, 'u-1')
    expect(sql).toBe(`UPDATE "user" SET "deleted_at" = now() WHERE "id" = $1 RETURNING *`)
    expect(params).toEqual(['u-1'])
  })
})

describe('emitRestoreById', () => {
  test('emits UPDATE … SET deleted_at = NULL WHERE id = $1 RETURNING *', () => {
    const { sql, params } = emitRestoreById(userSchema, 'u-1')
    expect(sql).toBe(`UPDATE "user" SET "deleted_at" = NULL WHERE "id" = $1 RETURNING *`)
    expect(params).toEqual(['u-1'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// QueryBuilder — default soft-delete scope
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder — default soft-delete scope', () => {
  test('soft-deletes schema: WHERE auto-appends "deleted_at" IS NULL', () => {
    const qb = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const { sql } = qb.toSql()
    expect(sql).toContain(`WHERE "deleted_at" IS NULL`)
  })

  test('non-soft-deletes schema: no extra predicate', () => {
    const qb = new QueryBuilder<EventLog>(hardSchema, {} as DatabaseExecutor, undefined)
    const { sql } = qb.toSql()
    expect(sql).not.toContain('deleted_at')
    expect(sql).not.toContain('WHERE')
  })

  test('default scope + user WHERE: predicates ANDed in order', () => {
    const qb = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const { sql, params } = qb.where('email', 'a@b.com').toSql()
    expect(sql).toContain(`WHERE "deleted_at" IS NULL AND "email" = $1`)
    expect(params).toEqual(['a@b.com'])
  })

  test('withTrashed() removes the default predicate', () => {
    const qb = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const { sql } = qb.withTrashed().toSql()
    expect(sql).not.toContain('WHERE')
  })

  test('withTrashed() + user WHERE: only the user predicate', () => {
    const qb = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const { sql } = qb.withTrashed().where('email', 'a@b.com').toSql()
    expect(sql).toContain('WHERE "email" = $1')
    expect(sql).not.toContain('"deleted_at" IS NULL')
    expect(sql).not.toContain('"deleted_at" IS NOT NULL')
  })

  test('onlyTrashed() flips the predicate to IS NOT NULL', () => {
    const qb = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const { sql } = qb.onlyTrashed().toSql()
    expect(sql).toContain(`WHERE "deleted_at" IS NOT NULL`)
  })

  test('onlyTrashed() throws on a schema without t.softDeletes()', () => {
    const qb = new QueryBuilder<EventLog>(hardSchema, {} as DatabaseExecutor, undefined)
    expect(() => qb.onlyTrashed()).toThrow(/doesn't declare t\.softDeletes/)
  })

  test('immutability: withTrashed/onlyTrashed return fresh builders', () => {
    const base = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const trashed = base.withTrashed()
    const only = base.onlyTrashed()
    expect(base.toSql().sql).toContain(`WHERE "deleted_at" IS NULL`)
    expect(trashed.toSql().sql).not.toContain('WHERE')
    expect(only.toSql().sql).toContain(`WHERE "deleted_at" IS NOT NULL`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Repository.delete — soft-delete vs hard-delete path
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.delete — soft-delete path', () => {
  test('schema with t.softDeletes(): emits UPDATE deleted_at = now() (not DELETE)', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'u-1',
      email: 'a@b.com',
      deleted_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    await repo.delete(makeUser('u-1'))
    expect(db.queriedOne).toHaveLength(1)
    expect(nonNull(db.queriedOne[0]).sql).toContain('UPDATE "user" SET "deleted_at" = now()')
    expect(db.executed).toHaveLength(0)
  })

  test('schema WITHOUT softDeletes: emits DELETE (hard path)', async () => {
    const db = new SpyDb()
    const repo = new EventLogRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    const log = new EventLog()
    log.id = 'e-1'
    log.action = 'signup'
    log.created_at = new Date()
    await repo.delete(log)
    expect(db.executed).toHaveLength(1)
    expect(nonNull(db.executed[0]).sql).toContain('DELETE FROM "event_log"')
    expect(db.queriedOne).toHaveLength(0)
  })

  test('lifecycle events fire with force: false on the soft path', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'u-1',
      email: 'a@b.com',
      deleted_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const events = new EventBus()
    const fired: Array<{ name: string; force?: boolean }> = []
    events.on('user.deleting', (p: unknown) => {
      fired.push({ name: 'deleting', force: (p as { force: boolean }).force })
    })
    events.on('user.deleted', (p: unknown) => {
      fired.push({ name: 'deleted', force: (p as { force: boolean }).force })
    })
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await repo.delete(makeUser('u-1'))
    expect(fired).toEqual([
      { name: 'deleting', force: false },
      { name: 'deleted', force: false },
    ])
  })

  test('soft-delete returns the hydrated trashed model (deleted_at set)', async () => {
    const db = new SpyDb()
    const trashedAt = new Date('2026-05-29T10:00:00Z')
    db.scriptedRow = {
      id: 'u-1',
      email: 'a@b.com',
      deleted_at: trashedAt,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    const result = (await repo.delete(makeUser('u-1'))) as User
    expect(result.deleted_at).toEqual(trashedAt)
  })

  test('cancelable user.deleting listener aborts the soft delete', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    events.on('user.deleting', () => {
      throw new Error('veto')
    })
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await expect(repo.delete(makeUser('u-1'))).rejects.toThrow(/veto/)
    expect(db.queriedOne).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Repository.forceDelete
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.forceDelete', () => {
  test('always hard-deletes, even on a soft-deletes schema', async () => {
    const db = new SpyDb()
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    await repo.forceDelete(makeUser('u-1'))
    expect(db.executed).toHaveLength(1)
    expect(nonNull(db.executed[0]).sql).toContain('DELETE FROM "user"')
    expect(db.queriedOne).toHaveLength(0)
  })

  test('fires .deleting / .deleted with force: true', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    const fired: Array<{ name: string; force: boolean }> = []
    events.on('user.deleting', (p: unknown) => {
      fired.push({ name: 'deleting', force: (p as { force: boolean }).force })
    })
    events.on('user.deleted', (p: unknown) => {
      fired.push({ name: 'deleted', force: (p as { force: boolean }).force })
    })
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await repo.forceDelete(makeUser('u-1'))
    expect(fired).toEqual([
      { name: 'deleting', force: true },
      { name: 'deleted', force: true },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Repository.restore
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.restore', () => {
  test('emits UPDATE deleted_at = NULL + fires .restoring then .restored', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'u-1',
      email: 'a@b.com',
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const events = new EventBus()
    const fired: string[] = []
    events.on('user.restoring', () => {
      fired.push('restoring')
    })
    events.on('user.restored', () => {
      fired.push('restored')
    })
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    const restored = await repo.restore(makeUser('u-1', 'a@b.com', new Date()))
    expect(fired).toEqual(['restoring', 'restored'])
    expect(nonNull(db.queriedOne[0]).sql).toContain('UPDATE "user" SET "deleted_at" = NULL')
    expect(restored.deleted_at).toBeNull()
  })

  test('cancelable user.restoring listener aborts the restore', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    events.on('user.restoring', () => {
      throw new Error('veto-restore')
    })
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await expect(repo.restore(makeUser('u-1', 'a@b.com', new Date()))).rejects.toThrow(
      /veto-restore/,
    )
    expect(db.queriedOne).toHaveLength(0)
  })

  test('throws on a schema without t.softDeletes()', async () => {
    const db = new SpyDb()
    const repo = new EventLogRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    const log = new EventLog()
    log.id = 'e-1'
    log.action = 'signup'
    log.created_at = new Date()
    await expect(repo.restore(log)).rejects.toThrow(/doesn't declare t\.softDeletes/)
  })

  test('throws NotFoundError when the row no longer exists', async () => {
    const db = new SpyDb()
    db.scriptedRow = null // RETURNING * returns nothing
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    await expect(repo.restore(makeUser('u-gone', 'a@b.com', new Date()))).rejects.toThrow(
      /no longer exists/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Repository.find / findMany — pick up the default soft-delete scope
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.find / findMany — soft-delete scope', () => {
  test('find() emits SELECT … WHERE deleted_at IS NULL AND id = $1', async () => {
    const db = new SpyDb()
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    await repo.find('u-1')
    const select = nonNull(db.queriedOne[0])
    expect(select.sql).toContain('WHERE "deleted_at" IS NULL AND "id" = $1')
  })

  test('findMany() emits SELECT … WHERE deleted_at IS NULL AND id IN (…)', async () => {
    const db = new SpyDb()
    db.scriptedRows = []
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    await repo.findMany(['u-1', 'u-2'])
    const select = nonNull(db.queried[0])
    expect(select.sql).toContain('WHERE "deleted_at" IS NULL AND "id" IN ($1, $2)')
  })

  test('apps that want trashed rows use .query().withTrashed().where(id, ...)', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'u-1',
      email: 'a@b.com',
      deleted_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new UserRepository({
      db: db as unknown as PostgresDatabase,
      events: new EventBus(),
    })
    const user = await repo.query().withTrashed().where('id', 'u-1').first()
    expect(user?.deleted_at).toBeInstanceOf(Date)
    const select = nonNull(db.queriedOne[0])
    expect(select.sql).not.toContain('"deleted_at" IS NULL')
    expect(select.sql).toContain('"id" = $1')
  })
})
