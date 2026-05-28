import { describe, expect, test } from 'bun:test'
import { Archetype, defineSchema, hidden, hiddenFieldsOf, Model } from '../src/index.ts'

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
