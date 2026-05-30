import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { AesGcm256Cipher, Cipher, isUlid, ValidationError } from '@strav/kernel'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  applyCastsToDb,
  applyDecryptToRow,
  applyEncryptToAttrs,
  applyUlidsToAttrs,
  cast,
  castFor,
  castsFor,
  defineSchema,
  encrypt,
  encryptedFieldsOf,
  hidden,
  hiddenFieldsOf,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
  ulid,
  ulidFieldsOf,
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
    const repo = new OrderRepository({ db: db as unknown as PostgresDatabase })
    const order = await repo.find('o-1')
    expect(order).not.toBeNull()
    expect(order?.total).toBeInstanceOf(Money)
    expect(order?.total.amount).toBe(99.95)
  })

  test('fields without @cast pass through unchanged', async () => {
    const db = new SpyDb()
    const created = new Date('2026-05-28T10:00:00Z')
    db.scriptedRow = { id: 'o-1', total: '12.00', created_at: created, updated_at: created }
    const repo = new OrderRepository({ db: db as unknown as PostgresDatabase })
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
    const repo = new OrderRepository({ db: db as unknown as PostgresDatabase })
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
    const repo = new OrderRepository({ db: db as unknown as PostgresDatabase })
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

// ─────────────────────────────────────────────────────────────────────────────
// @ulid — fixtures
// ─────────────────────────────────────────────────────────────────────────────

const jobSchema = defineSchema('job', Archetype.Entity, (t) => {
  t.id()
  t.string('correlation_id').max(26)
  t.string('status').max(32)
  t.timestamps()
})

class Job extends Model {
  static override readonly schema = jobSchema
  id!: string
  @ulid correlation_id!: string
  status!: string
  created_at!: Date
  updated_at!: Date
}

class JobRepository extends Repository<Job> {
  static override readonly schema = jobSchema
  static override readonly model: ModelClass = Job as unknown as ModelClass
}

// Schema with a nullable @ulid field — proves the null-passthrough on update.
const taskSchema = defineSchema('task', Archetype.Entity, (t) => {
  t.id()
  t.string('batch_id').max(26).nullable()
  t.timestamps()
})

class Task extends Model {
  static override readonly schema = taskSchema
  id!: string
  @ulid batch_id!: string | null
  created_at!: Date
  updated_at!: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// @ulid — metadata + applyUlidsToAttrs
// ─────────────────────────────────────────────────────────────────────────────

describe('@ulid — metadata helpers', () => {
  test('ulidFieldsOf returns the declared set', () => {
    expect(Array.from(ulidFieldsOf(Job))).toEqual(['correlation_id'])
  })

  test('classes without @ulid return an empty set', () => {
    expect(ulidFieldsOf(PlainUser).size).toBe(0)
  })
})

describe('@ulid — applyUlidsToAttrs (create mode)', () => {
  test('auto-fills a missing @ulid field with a fresh ULID', () => {
    const out = applyUlidsToAttrs(Job, { id: 'j-1' }, 'create')
    expect(typeof out.correlation_id).toBe('string')
    expect(isUlid(out.correlation_id as string)).toBe(true)
  })

  test('auto-fills when the field is explicitly undefined', () => {
    const out = applyUlidsToAttrs(Job, { id: 'j-1', correlation_id: undefined }, 'create')
    expect(typeof out.correlation_id).toBe('string')
    expect(isUlid(out.correlation_id as string)).toBe(true)
  })

  test('auto-fills when the field is explicitly null', () => {
    const out = applyUlidsToAttrs(Job, { id: 'j-1', correlation_id: null }, 'create')
    expect(typeof out.correlation_id).toBe('string')
    expect(isUlid(out.correlation_id as string)).toBe(true)
  })

  test('passes a valid caller-supplied ULID through unchanged', () => {
    const supplied = '01HZ8N3ZQVYJEXMP9YK0F0F0F0'
    const out = applyUlidsToAttrs(Job, { id: 'j-1', correlation_id: supplied }, 'create')
    expect(out.correlation_id).toBe(supplied)
  })

  test('throws ValidationError on a non-ULID string', () => {
    expect(() => applyUlidsToAttrs(Job, { correlation_id: 'not-a-ulid' }, 'create')).toThrow(
      ValidationError,
    )
  })

  test('ValidationError carries the field-level errors map', () => {
    try {
      applyUlidsToAttrs(Job, { correlation_id: 'too-short' }, 'create')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const v = err as ValidationError
      expect(v.errors.correlation_id?.[0]).toMatch(/Crockford-base32 ULID/)
    }
  })

  test('throws on non-string values (e.g. number)', () => {
    expect(() => applyUlidsToAttrs(Job, { correlation_id: 12345 }, 'create')).toThrow(
      ValidationError,
    )
  })

  test('returns a fresh object — never mutates the input', () => {
    const input = { id: 'j-1' } as Record<string, unknown>
    applyUlidsToAttrs(Job, input, 'create')
    expect(input).toEqual({ id: 'j-1' })
  })

  test('classes without @ulid pass attrs through unchanged', () => {
    const input = { id: 'u-1', email: 'a@b.com' }
    expect(applyUlidsToAttrs(PlainUser, input, 'create')).toEqual(input)
  })
})

describe('@ulid — applyUlidsToAttrs (update mode)', () => {
  test('does NOT auto-fill missing fields', () => {
    const out = applyUlidsToAttrs(Job, { id: 'j-1' }, 'update')
    expect(out).toEqual({ id: 'j-1' })
    expect(Object.hasOwn(out, 'correlation_id')).toBe(false)
  })

  test('validates a present value', () => {
    expect(() => applyUlidsToAttrs(Job, { correlation_id: 'nope' }, 'update')).toThrow(
      ValidationError,
    )
  })

  test('passes a valid present value through unchanged', () => {
    const supplied = '01HZ8N3ZQVYJEXMP9YK0F0F0F0'
    const out = applyUlidsToAttrs(Job, { correlation_id: supplied }, 'update')
    expect(out.correlation_id).toBe(supplied)
  })

  test('forwards null unchanged so callers can clear a nullable @ulid column', () => {
    const out = applyUlidsToAttrs(Task, { batch_id: null }, 'update')
    expect(out.batch_id).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @ulid — Repository integration
// ─────────────────────────────────────────────────────────────────────────────

describe('@ulid — Repository.create auto-generates + validates', () => {
  test('Repository.create auto-fills correlation_id when omitted', async () => {
    const db = new SpyDb()
    const generated = '01HZ8N3ZQVYJEXMP9YK0F0F0F1'
    db.scriptedRow = {
      id: 'j-1',
      correlation_id: generated,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new JobRepository({ db: db as unknown as PostgresDatabase })
    await repo.create({ id: 'j-1' } as unknown as Partial<Job>)
    const insert = nonNull(db.queriedOne.find((q) => q.sql.startsWith('INSERT')))
    // emitInsert sees the auto-filled ULID — it's in the params positional list.
    const ulidParam = insert.params.find((p): p is string => typeof p === 'string' && isUlid(p))
    expect(ulidParam).toBeDefined()
  })

  test('Repository.create passes a caller-supplied ULID through unchanged', async () => {
    const db = new SpyDb()
    const supplied = '01HZ8N3ZQVYJEXMP9YK0F0F0F0'
    db.scriptedRow = {
      id: 'j-1',
      correlation_id: supplied,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new JobRepository({ db: db as unknown as PostgresDatabase })
    await repo.create({ id: 'j-1', correlation_id: supplied } as unknown as Partial<Job>)
    const insert = nonNull(db.queriedOne.find((q) => q.sql.startsWith('INSERT')))
    expect(insert.params).toContain(supplied)
  })

  test('Repository.create rejects a non-ULID before hitting the DB', async () => {
    const db = new SpyDb()
    const repo = new JobRepository({ db: db as unknown as PostgresDatabase })
    await expect(
      repo.create({ id: 'j-1', correlation_id: 'nope' } as unknown as Partial<Job>),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(db.queriedOne).toHaveLength(0)
  })
})

describe('@ulid — Repository.update validates but does not auto-generate', () => {
  test('Repository.update rejects a non-ULID before hitting the DB', async () => {
    const db = new SpyDb()
    const repo = new JobRepository({ db: db as unknown as PostgresDatabase })
    const existing = new Job()
    existing.id = 'j-1'
    existing.correlation_id = '01HZ8N3ZQVYJEXMP9YK0F0F0F0'
    existing.created_at = new Date()
    existing.updated_at = new Date()
    await expect(
      repo.update(existing, { correlation_id: 'bad' } as unknown as Partial<Job>),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(db.queriedOne).toHaveLength(0)
  })

  test('Repository.update on a non-@ulid field does not touch correlation_id', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 'j-1',
      correlation_id: '01HZ8N3ZQVYJEXMP9YK0F0F0F0',
      status: 'done',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new JobRepository({ db: db as unknown as PostgresDatabase })
    const existing = new Job()
    existing.id = 'j-1'
    existing.correlation_id = '01HZ8N3ZQVYJEXMP9YK0F0F0F0'
    existing.status = 'pending'
    existing.created_at = new Date()
    existing.updated_at = new Date()
    await repo.update(existing, { status: 'done' } as unknown as Partial<Job>)
    const update = nonNull(db.queriedOne.find((q) => q.sql.startsWith('UPDATE')))
    // No new ULID generated for the unchanged @ulid field.
    expect(update.sql).not.toContain('"correlation_id"')
    expect(update.sql).toContain('"status"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @ulid — inheritance
// ─────────────────────────────────────────────────────────────────────────────

describe('@ulid — inheritance', () => {
  test('subclasses inherit parent @ulid fields', () => {
    class PriorityJob extends Job {
      priority!: number
    }
    expect(Array.from(ulidFieldsOf(PriorityJob))).toEqual(['correlation_id'])
  })

  test('subclass adding @ulid does not mutate the parent set', () => {
    class BatchedJob extends Job {
      @ulid batch_id!: string
      batch_index!: number
    }
    expect(Array.from(ulidFieldsOf(Job))).toEqual(['correlation_id'])
    expect(Array.from(ulidFieldsOf(BatchedJob)).sort()).toEqual(['batch_id', 'correlation_id'])
  })
})

describe('@ulid — interplay with @cast', () => {
  test('@ulid runs before @cast, so casts see the auto-generated string', () => {
    // @cast.toDb wraps the value in `WRAPPED:` to prove the order: if @ulid
    // ran first, the cast sees a real ULID string; if @cast ran first on an
    // undefined value, nothing happens and @ulid auto-fills afterwards with
    // a bare ULID. Either way the column gets a valid ULID — what we're
    // verifying here is that the auto-generated ULID is the value @cast.toDb
    // sees (and therefore wraps), not undefined.
    const wrappingSchema = defineSchema('wrap', Archetype.Entity, (t) => {
      t.id()
      t.string('correlation_id').max(64)
      t.timestamps()
    })
    class Wrap extends Model {
      static override readonly schema = wrappingSchema
      id!: string
      @ulid
      @cast({ toDb: (v: unknown) => `WRAPPED:${String(v)}` })
      correlation_id!: string
      created_at!: Date
      updated_at!: Date
    }
    const withUlids = applyUlidsToAttrs(Wrap, { id: 'w-1' }, 'create')
    expect(typeof withUlids.correlation_id).toBe('string')
    expect(isUlid(withUlids.correlation_id as string)).toBe(true)
    const final = applyCastsToDb(Wrap, withUlids)
    expect(typeof final.correlation_id).toBe('string')
    expect((final.correlation_id as string).startsWith('WRAPPED:')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @encrypt — fixtures
// ─────────────────────────────────────────────────────────────────────────────

const KEY = Uint8Array.from(randomBytes(32))
const realCipher = new AesGcm256Cipher(KEY)

const secretSchema = defineSchema('secret', Archetype.Entity, (t) => {
  t.id()
  t.encrypted('ssn')
  t.timestamps()
})

class Secret extends Model {
  static override readonly schema = secretSchema
  id!: string
  @encrypt ssn!: string
  created_at!: Date
  updated_at!: Date
}

class SecretRepository extends Repository<Secret> {
  static override readonly schema = secretSchema
  static override readonly model: ModelClass = Secret as unknown as ModelClass
}

// Repository with no cipher wired — proves the unconfigured path.
class UnconfiguredSecretRepository extends Repository<Secret> {
  static override readonly schema = secretSchema
  static override readonly model: ModelClass = Secret as unknown as ModelClass
}

// A model without @encrypt — proves the no-op path.
class PlainSecret extends Model {
  static override readonly schema = secretSchema
  id!: string
  ssn!: string
  created_at!: Date
  updated_at!: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// @encrypt — metadata + helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('@encrypt — metadata', () => {
  test('encryptedFieldsOf returns the declared set', () => {
    expect(Array.from(encryptedFieldsOf(Secret))).toEqual(['ssn'])
  })

  test('classes without @encrypt return an empty set', () => {
    expect(encryptedFieldsOf(PlainSecret).size).toBe(0)
  })
})

describe('@encrypt — applyEncryptToAttrs', () => {
  test('encrypts a present string value', () => {
    const out = applyEncryptToAttrs(Secret, { id: 's-1', ssn: '123-45-6789' }, realCipher)
    expect(out.ssn).toBeInstanceOf(Uint8Array)
    expect((out.ssn as Uint8Array).length).toBeGreaterThan(12 + 16) // iv+tag+ct
  })

  test('passes undefined / null / missing through unchanged', () => {
    expect(applyEncryptToAttrs(Secret, { id: 's-1' }, realCipher).ssn).toBeUndefined()
    expect(applyEncryptToAttrs(Secret, { id: 's-1', ssn: null }, realCipher).ssn).toBeNull()
    expect(
      applyEncryptToAttrs(Secret, { id: 's-1', ssn: undefined }, realCipher).ssn,
    ).toBeUndefined()
  })

  test('throws ValidationError on a non-string value', () => {
    expect(() => applyEncryptToAttrs(Secret, { ssn: 12345 }, realCipher)).toThrow(ValidationError)
  })

  test('classes without @encrypt pass attrs through unchanged', () => {
    const out = applyEncryptToAttrs(PlainSecret, { id: 's-1', ssn: 'cleartext' }, realCipher)
    expect(out).toEqual({ id: 's-1', ssn: 'cleartext' })
  })

  test('returns a fresh object — never mutates the input', () => {
    const input = { id: 's-1', ssn: 'secret' }
    applyEncryptToAttrs(Secret, input, realCipher)
    expect(input.ssn).toBe('secret')
  })
})

describe('@encrypt — applyDecryptToRow', () => {
  test('decrypts a Uint8Array column', () => {
    const ct = realCipher.encrypt('plain text')
    const out = applyDecryptToRow(Secret, { id: 's-1', ssn: ct }, realCipher)
    expect(out.ssn).toBe('plain text')
  })

  test('decrypts a Node Buffer column (Postgres bytea typically returns Buffer)', () => {
    const ct = realCipher.encrypt('from buffer')
    const buf = Buffer.from(ct)
    const out = applyDecryptToRow(Secret, { id: 's-1', ssn: buf }, realCipher)
    expect(out.ssn).toBe('from buffer')
  })

  test('passes null through unchanged', () => {
    const out = applyDecryptToRow(Secret, { id: 's-1', ssn: null }, realCipher)
    expect(out.ssn).toBeNull()
  })

  test('throws TypeError on a non-bytea value', () => {
    expect(() => applyDecryptToRow(Secret, { id: 's-1', ssn: 'not bytea' }, realCipher)).toThrow(
      TypeError,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @encrypt — Repository integration
// ─────────────────────────────────────────────────────────────────────────────

describe('@encrypt — Repository.create encrypts on write', () => {
  test('emitInsert sees a Uint8Array, not the plaintext', async () => {
    const db = new SpyDb()
    // Script a hydration row that uses the encrypted ciphertext, then a
    // freshly-encrypted blob for round-trip.
    const fakeCt = realCipher.encrypt('123-45-6789')
    db.scriptedRow = {
      id: 's-1',
      ssn: fakeCt,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SecretRepository({ db: db as unknown as PostgresDatabase, cipher: realCipher })
    await repo.create({ id: 's-1', ssn: '123-45-6789' } as unknown as Partial<Secret>)
    const insert = nonNull(db.queriedOne.find((q) => q.sql.startsWith('INSERT')))
    const ssnParam = insert.params.find((p) => p instanceof Uint8Array)
    expect(ssnParam).toBeDefined()
    expect(insert.params).not.toContain('123-45-6789')
  })

  test('Model.ssn comes back decrypted after create', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 's-1',
      ssn: realCipher.encrypt('123-45-6789'),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SecretRepository({ db: db as unknown as PostgresDatabase, cipher: realCipher })
    const model = await repo.create({ id: 's-1', ssn: '123-45-6789' } as unknown as Partial<Secret>)
    expect(model.ssn).toBe('123-45-6789')
  })
})

describe('@encrypt — Repository.find decrypts on read', () => {
  test('returns the decrypted plaintext, not the bytes', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 's-1',
      ssn: realCipher.encrypt('top-secret'),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SecretRepository({ db: db as unknown as PostgresDatabase, cipher: realCipher })
    const found = await repo.find('s-1')
    expect(found?.ssn).toBe('top-secret')
  })

  test('Postgres-style bytea returned as Buffer is handled', async () => {
    const db = new SpyDb()
    const ct = realCipher.encrypt('postgres-bytea')
    db.scriptedRow = {
      id: 's-1',
      ssn: Buffer.from(ct), // simulates pg returning bytea as Buffer
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SecretRepository({ db: db as unknown as PostgresDatabase, cipher: realCipher })
    const found = await repo.find('s-1')
    expect(found?.ssn).toBe('postgres-bytea')
  })
})

describe('@encrypt — Repository.update', () => {
  test('encrypts a changed value before UPDATE', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 's-1',
      ssn: realCipher.encrypt('new-value'),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repo = new SecretRepository({ db: db as unknown as PostgresDatabase, cipher: realCipher })
    const existing = new Secret()
    existing.id = 's-1'
    existing.ssn = 'old-value'
    existing.created_at = new Date()
    existing.updated_at = new Date()
    await repo.update(existing, { ssn: 'new-value' } as unknown as Partial<Secret>)
    const update = nonNull(db.queriedOne.find((q) => q.sql.startsWith('UPDATE')))
    const ssnParam = update.params.find((p) => p instanceof Uint8Array)
    expect(ssnParam).toBeDefined()
    expect(update.params).not.toContain('new-value')
  })
})

describe('@encrypt — Repository without a Cipher', () => {
  test('Repository with @encrypt model + no cipher throws on create', async () => {
    const db = new SpyDb()
    const repo = new UnconfiguredSecretRepository({ db: db as unknown as PostgresDatabase })
    await expect(
      repo.create({ id: 's-1', ssn: 'should-fail' } as unknown as Partial<Secret>),
    ).rejects.toThrow(/no Cipher is wired/)
    expect(db.queriedOne).toHaveLength(0)
  })

  test('Repository with @encrypt model + base Cipher throws on first encrypt call', async () => {
    const db = new SpyDb()
    const repo = new SecretRepository({
      db: db as unknown as PostgresDatabase,
      cipher: new Cipher(), // unconfigured base
    })
    await expect(
      repo.create({ id: 's-1', ssn: 'still-fails' } as unknown as Partial<Secret>),
    ).rejects.toThrow(/no encryption key/i)
  })

  test('a model WITHOUT @encrypt works fine without a Cipher', async () => {
    const db = new SpyDb()
    db.scriptedRow = {
      id: 's-1',
      ssn: 'cleartext',
      created_at: new Date(),
      updated_at: new Date(),
    }
    // Use the plain (no @encrypt) Secret model.
    class PlainRepo extends Repository<PlainSecret> {
      static override readonly schema = secretSchema
      static override readonly model: ModelClass = PlainSecret as unknown as ModelClass
    }
    const repo = new PlainRepo({ db: db as unknown as PostgresDatabase })
    const created = await repo.create({
      id: 's-1',
      ssn: 'cleartext',
    } as unknown as Partial<PlainSecret>)
    expect(created.ssn).toBe('cleartext')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @encrypt — interplay with @cast (cast.toDb runs first on write,
// cast.fromDb runs after decrypt on read)
// ─────────────────────────────────────────────────────────────────────────────

describe('@encrypt — order with @cast', () => {
  test('@cast.toDb runs BEFORE @encrypt on the write path', () => {
    // Cast wraps the value in `CASTED:`. After encryption, the resulting
    // ciphertext is a bytea blob that, when decrypted, must start with
    // 'CASTED:' — proving cast ran first.
    const wrappingSchema = defineSchema('wrap_secret', Archetype.Entity, (t) => {
      t.id()
      t.encrypted('payload')
      t.timestamps()
    })
    class WrapSecret extends Model {
      static override readonly schema = wrappingSchema
      id!: string
      @encrypt
      @cast({ toDb: (v: unknown) => `CASTED:${String(v)}`, fromDb: (v: unknown) => String(v) })
      payload!: string
      created_at!: Date
      updated_at!: Date
    }
    const casted = applyCastsToDb(WrapSecret, { id: 'w-1', payload: 'raw' })
    expect(casted.payload).toBe('CASTED:raw')
    const encrypted = applyEncryptToAttrs(WrapSecret, casted, realCipher)
    expect(encrypted.payload).toBeInstanceOf(Uint8Array)
    expect(realCipher.decrypt(encrypted.payload as Uint8Array)).toBe('CASTED:raw')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// @encrypt — inheritance
// ─────────────────────────────────────────────────────────────────────────────

describe('@encrypt — inheritance', () => {
  test('subclasses inherit parent @encrypt fields', () => {
    class AuditedSecret extends Secret {
      audit_note!: string
    }
    expect(Array.from(encryptedFieldsOf(AuditedSecret))).toEqual(['ssn'])
  })

  test('subclass adding @encrypt does not mutate the parent set', () => {
    class DoubleSecret extends Secret {
      @encrypt second_secret!: string
    }
    expect(Array.from(encryptedFieldsOf(Secret))).toEqual(['ssn'])
    expect(Array.from(encryptedFieldsOf(DoubleSecret)).sort()).toEqual(['second_secret', 'ssn'])
  })
})
