import { describe, expect, test } from 'bun:test'
import { EventBus } from '@strav/kernel'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  defineSchema,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
  UnitOfWork,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

function nonNull<T>(v: T | null | undefined, msg = 'expected non-null'): T {
  if (v === null || v === undefined) throw new Error(msg)
  return v
}

/** Database stub that opens an empty transaction; tracks tx + commit attempts. */
class FakeDb implements Database {
  transactionsOpened = 0
  /** Number of times the user's callback returned without throwing (== "would commit"). */
  commits = 0
  /** Number of times the user's callback threw (== "would rollback"). */
  rollbacks = 0
  /** SQL recorded inside the open transaction (post-set_config etc.). */
  readonly txSql: Array<{ sql: string; params: readonly unknown[] }> = []

  async query<T>(): Promise<T[]> {
    return []
  }
  async queryOne<T>(): Promise<T | null> {
    return null
  }
  async execute(): Promise<number> {
    return 0
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    this.transactionsOpened++
    const tx: DatabaseExecutor = {
      query: async () => [],
      queryOne: async () => null,
      execute: async (sql, params = []) => {
        this.txSql.push({ sql, params })
        return 0
      },
    }
    try {
      const result = await fn(tx)
      this.commits++
      return result
    } catch (e) {
      this.rollbacks++
      throw e
    }
  }
  async close() {}
  raw(): never {
    throw new Error('FakeDb.raw not implemented')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UnitOfWork — basic shape
// ─────────────────────────────────────────────────────────────────────────────

describe('UnitOfWork.run', () => {
  test('opens one transaction and returns fn result', async () => {
    const db = new FakeDb()
    const uow = new UnitOfWork(db, new EventBus())
    const result = await uow.run(async () => 42)
    expect(result).toBe(42)
    expect(db.transactionsOpened).toBe(1)
    expect(db.commits).toBe(1)
    expect(db.rollbacks).toBe(0)
  })

  test('propagates exceptions from fn — rolls back', async () => {
    const db = new FakeDb()
    const uow = new UnitOfWork(db, new EventBus())
    await expect(
      uow.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)
    expect(db.commits).toBe(0)
    expect(db.rollbacks).toBe(1)
  })

  test('nested run reuses the outer transaction', async () => {
    const db = new FakeDb()
    const uow = new UnitOfWork(db, new EventBus())
    await uow.run(async () => {
      await uow.run(async () => undefined)
    })
    expect(db.transactionsOpened).toBe(1)
  })

  test('works without an EventBus — events skip, transaction runs fine', async () => {
    const db = new FakeDb()
    const uow = new UnitOfWork(db, undefined)
    const result = await uow.run(async () => 7)
    expect(result).toBe(7)
    expect(db.transactionsOpened).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UnitOfWork + Repository — explicit tx + ambient ALS + queue-until-commit
// ─────────────────────────────────────────────────────────────────────────────

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
})

class User extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  created_at!: Date
  updated_at!: Date
}

class UserRepository extends Repository<User> {
  static override readonly schema = userSchema
  static override readonly model: ModelClass = User as unknown as ModelClass
}

/** Spy DB that captures whether each query came through the tx or default. */
class SpyDb implements Database {
  defaultCalls: Array<{ sql: string }> = []
  txCalls: Array<{ sql: string }> = []
  transactionsOpened = 0

  async query<T>(): Promise<T[]> {
    return []
  }
  async queryOne<T>(sql: string): Promise<T | null> {
    this.defaultCalls.push({ sql })
    return this.scriptedInsert(sql) as T | null
  }
  async execute(sql: string): Promise<number> {
    this.defaultCalls.push({ sql })
    return 1
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    this.transactionsOpened++
    const tx: DatabaseExecutor = {
      query: async () => [],
      queryOne: async (sql: string) => {
        this.txCalls.push({ sql })
        return this.scriptedInsert(sql) as never
      },
      execute: async (sql: string) => {
        this.txCalls.push({ sql })
        return 1
      },
    }
    return fn(tx)
  }
  async close() {}
  raw(): never {
    throw new Error('SpyDb.raw not implemented')
  }

  /** Synthesize a RETURNING * row for any INSERT, so Repository.create succeeds. */
  private scriptedInsert(sql: string): Record<string, unknown> | null {
    if (!/INSERT INTO "user".*RETURNING \*/i.test(sql)) return null
    return {
      id: 'fake-id',
      email: 'a@b.com',
      created_at: new Date(),
      updated_at: new Date(),
    }
  }
}

describe('Repository — explicit { tx } parameter', () => {
  test('routes through the supplied tx, not the default db', async () => {
    const db = new SpyDb()
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events: new EventBus() })
    await db.transaction(async (tx) => {
      await repo.find('id-1', { tx })
    })
    expect(db.txCalls.length).toBeGreaterThan(0)
    expect(db.defaultCalls.length).toBe(0)
  })

  test('without opts, uses the default db (no transaction)', async () => {
    const db = new SpyDb()
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events: new EventBus() })
    await repo.find('id-1')
    expect(db.defaultCalls.length).toBe(1)
    expect(db.txCalls.length).toBe(0)
  })
})

describe('Repository — ambient UoW.run scope', () => {
  test('Repository.find inside uow.run uses the tx automatically', async () => {
    const db = new SpyDb()
    const uow = new UnitOfWork(db, new EventBus())
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events: new EventBus() })
    await uow.run(async () => {
      await repo.find('id-1')
    })
    expect(db.txCalls.length).toBe(1)
    expect(db.defaultCalls.length).toBe(0)
  })

  test('explicit { tx } overrides the ambient scope', async () => {
    const db = new SpyDb()
    const uow = new UnitOfWork(db, new EventBus())
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events: new EventBus() })
    // Build an explicit "other" tx that ISN'T the one UoW will open.
    const otherTx: DatabaseExecutor = {
      query: async () => [],
      queryOne: async () => null,
      execute: async () => 0,
    }
    let usedOther = false
    const monitorTx: DatabaseExecutor = {
      query: otherTx.query,
      queryOne: async (sql, p) => {
        usedOther = true
        return otherTx.queryOne(sql, p)
      },
      execute: otherTx.execute,
    }
    await uow.run(async () => {
      await repo.find('id-1', { tx: monitorTx })
    })
    expect(usedOther).toBe(true)
    expect(db.txCalls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Event queue — post-events fire on commit, drop on rollback
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository post-events inside UoW.run', () => {
  test('user.created fires AFTER fn returns + only once', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    const fired: string[] = []
    events.on('user.created', () => {
      fired.push('created')
    })
    const uow = new UnitOfWork(db, events)
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await uow.run(async () => {
      await repo.create({ email: 'a@b.com' } as Partial<User>)
      // Inside the callback, the event hasn't fired yet — it's queued.
      expect(fired).toEqual([])
    })
    // After uow.run completes, the queue has flushed.
    expect(fired).toEqual(['created'])
  })

  test('thrown fn drops the queue — no .created fires', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    const fired: string[] = []
    events.on('user.created', () => {
      fired.push('created')
    })
    const uow = new UnitOfWork(db, events)
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await expect(
      uow.run(async () => {
        await repo.create({ email: 'a@b.com' } as Partial<User>)
        throw new Error('rollback')
      }),
    ).rejects.toThrow(/rollback/)
    expect(fired).toEqual([])
  })

  test('cancelable user.creating events STILL fire immediately + can abort', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    events.on('user.creating', () => {
      throw new Error('veto')
    })
    const uow = new UnitOfWork(db, events)
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await expect(
      uow.run(async () => {
        await repo.create({ email: 'a@b.com' } as Partial<User>)
      }),
    ).rejects.toThrow(/veto/)
    // No INSERT made it through.
    expect(db.txCalls.length).toBe(0)
  })

  test('listener throw on a post-event is swallowed (consistent with non-cancelable semantic)', async () => {
    const db = new SpyDb()
    const reported: unknown[] = []
    const events = new EventBus({ onListenerError: (err) => reported.push(err) })
    events.on('user.created', () => {
      throw new Error('listener-failed')
    })
    const uow = new UnitOfWork(db, events)
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    // UoW.run resolves — listener errors on non-cancelable events route
    // through the bus's `onListenerError` rather than propagating.
    await uow.run(async () => {
      await repo.create({ email: 'a@b.com' } as Partial<User>)
    })
    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('listener-failed')
    // INSERT still committed — listener throws don't roll back; apps that
    // need transaction-aborting side effects use the cancelable `.creating`
    // / `.updating` / `.deleting` events instead.
    expect(db.txCalls.length).toBe(1)
  })

  test('outside any UoW, post-events fire immediately (unchanged behavior)', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    const fired: string[] = []
    events.on('user.created', () => {
      fired.push('created')
    })
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await repo.create({ email: 'a@b.com' } as Partial<User>)
    expect(fired).toEqual(['created'])
  })

  test('queue preserves cross-resource order (multiple creates flushing in FIFO)', async () => {
    const db = new SpyDb()
    const events = new EventBus()
    const fired: string[] = []
    events.on('user.created', () => {
      fired.push('A')
    })
    events.on('user.created', () => {
      fired.push('B')
    })
    const uow = new UnitOfWork(db, events)
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
    await uow.run(async () => {
      await repo.create({ email: 'a@b.com' } as Partial<User>)
      await repo.create({ email: 'a@b.com' } as Partial<User>)
    })
    // Two created events × two listeners each, registration order preserved.
    expect(fired).toEqual(['A', 'B', 'A', 'B'])
    // Use nonNull just to keep biome happy about array indexing in tests.
    expect(nonNull(fired[0])).toBe('A')
  })
})
