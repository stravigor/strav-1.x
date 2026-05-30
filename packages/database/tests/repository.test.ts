import { beforeEach, describe, expect, test } from 'bun:test'
import { NotFoundError } from '@strav/kernel'
import {
  Archetype,
  defineSchema,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
} from '../src/index.ts'
import { InMemoryDatabase } from './in_memory_database.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.string('name')
  t.timestamps()
})

class User extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  name!: string
  created_at!: Date
  updated_at!: Date
}

class UserRepository extends Repository<User> {
  static override readonly schema = userSchema
  // `ModelClass<User>` is what `User` itself satisfies — the class has the
  // required static `schema` plus the construct signature.
  static override readonly model: ModelClass = User as unknown as ModelClass
}

/**
 * InMemoryDatabase that *also* simulates rows for the user table. The
 * runner stub elsewhere only handles `_strav_migrations`; this subclass
 * adds enough behavior to drive Repository CRUD assertions.
 */
class FakeUserDb extends InMemoryDatabase {
  private rows = new Map<string, Record<string, unknown>>()
  /** Latest SQL the Repository emitted via execute() — for assertions. */
  lastSql: string | undefined
  lastParams: readonly unknown[] | undefined

  override async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    this.lastSql = sql
    this.lastParams = params
    // Order matters: aggregate / existence checks must hit *before* the
    // generic row-read branch, otherwise their special shapes get clobbered.
    if (/SELECT COUNT\(\*\)/i.test(sql)) {
      return [{ count: this.rows.size } as unknown as T]
    }
    if (/SELECT 1 FROM "user"/i.test(sql)) {
      return (this.rows.size > 0 ? [{ '?column?': 1 }] : []) as unknown as T[]
    }
    if (/SELECT .+ FROM "user"/i.test(sql)) {
      if (/WHERE "id" IN/i.test(sql)) {
        return params
          .map((id) => this.rows.get(String(id)))
          .filter((r): r is Record<string, unknown> => r !== undefined) as T[]
      }
      if (/WHERE "id" = \$1/i.test(sql)) {
        const row = this.rows.get(String(params[0]))
        return (row ? [row] : []) as T[]
      }
      // SELECT every-column-list FROM "user" — return all rows.
      return [...this.rows.values()] as T[]
    }
    return super.query(sql, params)
  }

  override async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    this.lastSql = sql
    this.lastParams = params
    if (/INSERT INTO "user".+RETURNING \*/i.test(sql)) {
      const row = this.parseInsertReturning(sql, params)
      this.rows.set(String(row.id), row)
      return row as T
    }
    if (/UPDATE "user".+RETURNING \*/i.test(sql)) {
      const id = String(params[params.length - 1])
      const row = this.rows.get(id)
      if (!row) return null
      const updated = this.applyUpdate(sql, params, row)
      this.rows.set(id, updated)
      return updated as T
    }
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  override async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.lastSql = sql
    this.lastParams = params
    if (/DELETE FROM "user" WHERE "id" = \$1/i.test(sql)) {
      const before = this.rows.size
      this.rows.delete(String(params[0]))
      return before - this.rows.size
    }
    return super.execute(sql, params)
  }

  /** Seed a row directly (bypasses Repository). */
  seed(row: Record<string, unknown>): void {
    this.rows.set(String(row.id), row)
  }
  /** All rows currently in the fake table. */
  allRows(): readonly Record<string, unknown>[] {
    return [...this.rows.values()]
  }

  private parseInsertReturning(sql: string, params: readonly unknown[]): Record<string, unknown> {
    // Pull `("id", "email", "name", …)` out of the SQL.
    const match = /INSERT INTO "user" \(([^)]+)\)/i.exec(sql)
    if (!match) return {}
    const cols = (match[1] ?? '').split(',').map((c) => c.trim().replace(/"/g, ''))
    const row: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i]
      if (col) row[col] = params[i]
    }
    // Simulate DB defaults — populate timestamps when the schema declared them.
    if (!('created_at' in row)) row.created_at = new Date()
    if (!('updated_at' in row)) row.updated_at = new Date()
    return row
  }

  private applyUpdate(
    sql: string,
    params: readonly unknown[],
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const setMatch = /SET (.+?) WHERE/i.exec(sql)
    if (!setMatch) return row
    const assignments = (setMatch[1] ?? '').split(',').map((a) => a.trim())
    const next = { ...row }
    let paramIdx = 0
    for (const assignment of assignments) {
      const [rawCol, rawRhs] = assignment.split('=').map((s) => s.trim())
      if (!rawCol) continue
      const col = rawCol.replace(/"/g, '')
      if (rawRhs === 'now()') {
        next[col] = new Date()
      } else {
        next[col] = params[paramIdx]
        paramIdx++
      }
    }
    return next
  }
}

let db: FakeUserDb
let repo: UserRepository

beforeEach(() => {
  db = new FakeUserDb()
  repo = new UserRepository({ db: db as unknown as PostgresDatabase })
})

// ─────────────────────────────────────────────────────────────────────────────
// Subclass guards
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository — subclass requirements', () => {
  test('throws when subclass is missing `static schema`', () => {
    class Bad extends Repository<User> {
      static override readonly model: ModelClass = User as unknown as ModelClass
    }
    expect(() => new Bad({ db: db as unknown as PostgresDatabase })).toThrow(/static schema/)
  })

  test('throws when subclass is missing `static model`', () => {
    class Bad extends Repository<User> {
      static override readonly schema = userSchema
    }
    expect(() => new Bad({ db: db as unknown as PostgresDatabase })).toThrow(/static model/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Finders
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository — find / findOrFail / findMany', () => {
  test('find returns hydrated model when row exists', async () => {
    db.seed({
      id: 'u-1',
      email: 'a@b.com',
      name: 'Alice',
      created_at: new Date(),
      updated_at: new Date(),
    })
    const found = await repo.find('u-1')
    expect(found).toBeInstanceOf(User)
    expect(found?.email).toBe('a@b.com')
  })

  test('find returns null when row missing', async () => {
    expect(await repo.find('nope')).toBeNull()
  })

  test('findOrFail throws NotFoundError with stable code', async () => {
    await expect(repo.findOrFail('nope')).rejects.toThrow(NotFoundError)
    try {
      await repo.findOrFail('nope')
    } catch (err) {
      expect((err as NotFoundError).code).toBe('user.not-found')
    }
  })

  test('findMany returns rows in supplied id order (or all matched)', async () => {
    db.seed({ id: 'a', email: '1@x.com', name: 'A' })
    db.seed({ id: 'b', email: '2@x.com', name: 'B' })
    db.seed({ id: 'c', email: '3@x.com', name: 'C' })
    const users = await repo.findMany(['a', 'c'])
    const ids = users.map((u) => u.id).sort()
    expect(ids).toEqual(['a', 'c'])
  })

  test('findMany with empty list short-circuits (no SQL)', async () => {
    const out = await repo.findMany([])
    expect(out).toEqual([])
    expect(db.lastSql).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository — create / update / delete', () => {
  test('create auto-mints ULID id and persists', async () => {
    const user = await repo.create({ email: 'a@b.com', name: 'Alice' })
    expect(typeof user.id).toBe('string')
    expect(user.id.length).toBe(26)
    expect(user.email).toBe('a@b.com')
    expect(db.allRows()).toHaveLength(1)
  })

  test('create accepts a caller-supplied id', async () => {
    const user = await repo.create({ id: 'user_42', email: 'a@b.com', name: 'A' })
    expect(user.id).toBe('user_42')
  })

  test('update bumps updated_at and changes the named column', async () => {
    const original = await repo.create({ email: 'old@b.com', name: 'A' })
    const before = original.updated_at
    // Force a small clock gap so the new updated_at is strictly later.
    await new Promise((r) => setTimeout(r, 2))
    const updated = await repo.update(original, { email: 'new@b.com' } as Partial<User>)
    expect(updated.email).toBe('new@b.com')
    expect(updated.updated_at.getTime()).toBeGreaterThan(before.getTime())
  })

  test('update throws NotFoundError when the row is gone', async () => {
    const ghost = Object.assign(new User(), { id: 'missing' }) as User
    await expect(repo.update(ghost, { name: 'Z' } as Partial<User>)).rejects.toThrow(NotFoundError)
  })

  test('delete removes the row', async () => {
    const user = await repo.create({ email: 'a@b.com', name: 'A' })
    await repo.delete(user)
    expect(await repo.find(user.id)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Query + aggregates
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository — query / exists / count', () => {
  test('query() returns a QueryBuilder rooted on the schema', async () => {
    db.seed({ id: 'a', email: 'one@x.com', name: 'A' })
    db.seed({ id: 'b', email: 'two@x.com', name: 'B' })
    const all = await repo.query().get()
    expect(all.map((u) => u.id).sort()).toEqual(['a', 'b'])
    expect(all[0]).toBeInstanceOf(User)
  })

  test('exists short-circuits with SELECT 1 ... LIMIT 1', async () => {
    expect(await repo.exists({ email: 'nope' } as Partial<User>)).toBe(false)
    db.seed({ id: 'a', email: 'x@x.com', name: 'A' })
    expect(await repo.exists({ email: 'x@x.com' } as Partial<User>)).toBe(true)
  })

  test('count returns aggregate from the matching set', async () => {
    db.seed({ id: 'a', email: '1@x.com', name: 'A' })
    db.seed({ id: 'b', email: '2@x.com', name: 'B' })
    expect(await repo.count()).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Model hydration
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository — hydration', () => {
  test('drops columns the schema does not declare', async () => {
    db.seed({
      id: 'a',
      email: 'a@b.com',
      name: 'A',
      junk: 'should not appear',
    })
    const user = await repo.find('a')
    expect(user).not.toBeNull()
    expect((user as unknown as Record<string, unknown>).junk).toBeUndefined()
  })

  test('all() hydrates every row through the model class', async () => {
    db.seed({ id: 'a', email: '1@x.com', name: 'A' })
    db.seed({ id: 'b', email: '2@x.com', name: 'B' })
    const users = await repo.all()
    expect(users.every((u) => u instanceof User)).toBe(true)
  })
})
