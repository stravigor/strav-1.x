import { describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  applyCastsToDb,
  cast,
  castFor,
  castsFor,
  defineSchema,
  hidden,
  hiddenFieldsOf,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
} from '../src/index.ts'

function nonNull<T>(v: T | null | undefined, msg = 'expected non-null'): T {
  if (v === null || v === undefined) throw new Error(msg)
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email')
  t.string('password_hash')
  t.timestamps()
})

class User extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  @hidden password_hash!: string
  created_at!: Date
  updated_at!: Date
}

class PlainUser extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  password_hash!: string
}

// ─────────────────────────────────────────────────────────────────────────────
// @hidden
// ─────────────────────────────────────────────────────────────────────────────

describe('@hidden + Model.toJSON', () => {
  test('hiddenFieldsOf returns the declared set', () => {
    expect(Array.from(hiddenFieldsOf(User))).toEqual(['password_hash'])
  })

  test('classes without @hidden return an empty set', () => {
    expect(hiddenFieldsOf(PlainUser).size).toBe(0)
  })

  test('toJSON omits @hidden fields', () => {
    const u = new User()
    u.id = 'u-1'
    u.email = 'a@b.com'
    u.password_hash = 'hashed'
    u.created_at = new Date('2026-05-28T10:00:00Z')
    u.updated_at = new Date('2026-05-28T10:00:00Z')
    const json = u.toJSON()
    expect(json).not.toHaveProperty('password_hash')
    expect(json).toMatchObject({ id: 'u-1', email: 'a@b.com' })
  })

  test('JSON.stringify uses the toJSON override', () => {
    const u = new User()
    u.id = 'u-1'
    u.email = 'a@b.com'
    u.password_hash = 'hashed'
    const parsed = JSON.parse(JSON.stringify(u)) as Record<string, unknown>
    expect(parsed.password_hash).toBeUndefined()
    expect(parsed.email).toBe('a@b.com')
  })

  test('Models without @hidden serialize everything as before', () => {
    const u = new PlainUser()
    u.id = 'u-2'
    u.email = 'b@b.com'
    u.password_hash = 'leak'
    const parsed = JSON.parse(JSON.stringify(u)) as Record<string, unknown>
    expect(parsed.password_hash).toBe('leak')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Inheritance
// ─────────────────────────────────────────────────────────────────────────────

describe('@hidden inheritance', () => {
  test('subclasses inherit parent @hidden fields', () => {
    class SuperUser extends User {
      role!: string
    }
    const su = new SuperUser()
    su.id = 'u-3'
    su.email = 'c@b.com'
    su.password_hash = 'hashed'
    su.role = 'admin'
    const parsed = JSON.parse(JSON.stringify(su)) as Record<string, unknown>
    expect(parsed.password_hash).toBeUndefined()
    expect(parsed.role).toBe('admin')
  })

  test('subclass adding its own @hidden does not mutate the parent set', () => {
    class AuditedUser extends User {
      @hidden internal_audit_token!: string
      role!: string
    }
    // User still has only password_hash hidden.
    expect(Array.from(hiddenFieldsOf(User))).toEqual(['password_hash'])
    // AuditedUser has both.
    const auditedHidden = Array.from(hiddenFieldsOf(AuditedUser)).sort()
    expect(auditedHidden).toEqual(['internal_audit_token', 'password_hash'])

    const a = new AuditedUser()
    a.id = 'u-4'
    a.email = 'd@b.com'
    a.password_hash = 'hashed'
    a.internal_audit_token = 'secret'
    a.role = 'admin'
    const parsed = JSON.parse(JSON.stringify(a)) as Record<string, unknown>
    expect(parsed.password_hash).toBeUndefined()
    expect(parsed.internal_audit_token).toBeUndefined()
    expect(parsed.role).toBe('admin')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @cast
// ─────────────────────────────────────────────────────────────────────────────

/** Trivial value-object for testing the cast contract. */
class Money {
  constructor(readonly amount: number) {}
  static fromString(s: string): Money {
    return new Money(Number.parseFloat(s))
  }
  toString(): string {
    return this.amount.toFixed(2)
  }
}

const orderSchema = defineSchema('order', Archetype.Entity, (t) => {
  t.id()
  t.decimal('total', 12, 2)
  t.timestamps()
})

class Order extends Model {
  static override readonly schema = orderSchema
  id!: string
  @cast({
    fromDb: (raw: unknown) => Money.fromString(String(raw)),
    toDb: (m: unknown) => (m as Money).toString(),
  })
  total!: Money
  created_at!: Date
  updated_at!: Date
}

class OrderRepository extends Repository<Order> {
  static override readonly schema = orderSchema
  static override readonly model: ModelClass = Order as unknown as ModelClass
}

describe('@cast — metadata + helpers', () => {
  test('castsFor returns the declared casts', () => {
    expect(castsFor(Order).size).toBe(1)
    expect(castFor(Order, 'total')).toBeDefined()
  })

  test('classes without @cast return an empty map', () => {
    expect(castsFor(Money).size).toBe(0)
  })

  test('applyCastsToDb transforms decorated fields, leaves others alone', () => {
    const out = applyCastsToDb(Order, { id: 'o-1', total: new Money(42.5), other: 'untouched' })
    expect(out.id).toBe('o-1')
    expect(out.total).toBe('42.50')
    expect(out.other).toBe('untouched')
  })

  test('applyCastsToDb skips fields not present in attrs', () => {
    const out = applyCastsToDb(Order, { id: 'o-1' })
    expect(out).toEqual({ id: 'o-1' })
  })

  test('applyCastsToDb passes through undefined values without invoking toDb', () => {
    const out = applyCastsToDb(Order, { id: 'o-1', total: undefined })
    expect(out.total).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @cast — Repository integration
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal Database that scripts a single row + records every SQL string. */
class SpyDb implements Database {
  readonly executed: Array<{ sql: string; params: readonly unknown[] }> = []
  readonly queriedOne: Array<{ sql: string; params: readonly unknown[] }> = []
  scriptedRow: Record<string, unknown> | null = null

  async query<T>(): Promise<T[]> {
    return []
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

describe('@cast — Repository.hydrate runs fromDb', () => {
  test('Repository.find returns a Money instance, not the raw string', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'o-1',
      total: '99.95',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new OrderRepository(db as unknown as PostgresDatabase)
    const order = await repo.find('o-1')
    expect(order).not.toBeNull()
    expect(order?.total).toBeInstanceOf(Money)
    expect(order?.total.amount).toBe(99.95)
  })

  test('fields without @cast pass through unchanged', async () => {
    const db = new SpyDb()
    const created = new Date('2026-05-28T10:00:00Z')
    db.scriptedRow = { id: 'o-1', total: '12.00', created_at: created, updated_at: created }
    const repo = new OrderRepository(db as unknown as PostgresDatabase)
    const order = await repo.find('o-1')
    expect(order?.id).toBe('o-1')
    expect(order?.created_at).toBe(created)
  })
})

describe('@cast — Repository.create / update run toDb', () => {
  test('Repository.create passes the casted string to emitInsert', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'o-1',
      total: '50.00',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new OrderRepository(db as unknown as PostgresDatabase)
    await repo.create({ id: 'o-1', total: new Money(50) } as unknown as Partial<Order>)
    const insert = nonNull(db.queriedOne.find((q) => q.sql.startsWith('INSERT')))
    // Params include the casted '50.00' string, not the Money object.
    expect(insert.params).toContain('50.00')
    expect(insert.params).not.toContain(new Money(50))
  })

  test('Repository.update passes the casted string to emitUpdateById', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'o-1',
      total: '75.25',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new OrderRepository(db as unknown as PostgresDatabase)
    const existing = new Order()
    existing.id = 'o-1'
    existing.total = new Money(50)
    existing.created_at = new Date()
    existing.updated_at = new Date()
    await repo.update(existing, { total: new Money(75.25) } as unknown as Partial<Order>)
    const update = nonNull(db.queriedOne.find((q) => q.sql.startsWith('UPDATE')))
    expect(update.params).toContain('75.25')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @cast — inheritance
// ─────────────────────────────────────────────────────────────────────────────

describe('@cast — inheritance', () => {
  test('subclasses inherit parent casts', () => {
    class PaidOrder extends Order {
      paid_at!: Date
    }
    expect(castsFor(PaidOrder).get('total')).toBeDefined()
  })

  test('subclass adding @cast does not mutate the parent map', () => {
    class CustomOrder extends Order {
      @cast({ fromDb: (v: unknown) => Number(v) }) custom_field!: number
    }
    // Parent still has only `total`.
    expect(Array.from(castsFor(Order).keys())).toEqual(['total'])
    // Subclass has both.
    expect(Array.from(castsFor(CustomOrder).keys()).sort()).toEqual(['custom_field', 'total'])
  })

  test('subclass overriding the SAME field replaces the caster', () => {
    class CentOrder extends Order {
      // Re-cast to a plain number (cents) — overrides the Money parent caster.
      // `declare` so TS treats the redeclaration as a type-only override;
      // the runtime decorator is what registers the new caster.
      @cast({ fromDb: (raw: unknown) => Number.parseInt(String(raw), 10) })
      declare total: Money
    }
    const parentCaster = nonNull(castFor(Order, 'total'))
    const childCaster = nonNull(castFor(CentOrder, 'total'))
    expect(childCaster).not.toBe(parentCaster)
  })
})
