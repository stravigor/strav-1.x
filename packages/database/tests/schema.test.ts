import { describe, expect, test } from 'bun:test'
import {
  Archetype,
  type DecimalField,
  defineSchema,
  type EnumField,
  type ReferenceField,
  type StringField,
  type TimestampField,
} from '../src/index.ts'

describe('defineSchema', () => {
  test('returns a frozen schema with name + archetype + fields', () => {
    const s = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').unique().notNull()
    })
    expect(s.name).toBe('user')
    expect(s.archetype).toBe(Archetype.Entity)
    expect(Object.isFrozen(s)).toBe(true)
    expect(s.fields).toHaveLength(2)
  })

  test('rejects an invalid (non snake_case) name', () => {
    expect(() => defineSchema('User', Archetype.Entity, () => {})).toThrow(/snake_case/)
    expect(() => defineSchema('1bad', Archetype.Entity, () => {})).toThrow(/snake_case/)
  })

  test('rejects tenantRegistry + tenanted together', () => {
    expect(() =>
      defineSchema('x', Archetype.Entity, () => {}, { tenantRegistry: true, tenanted: true }),
    ).toThrow(/mutually exclusive/)
  })
})

describe('SchemaBuilder — primitive fields', () => {
  test('id() defaults to ULID kind, name "id"', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.id())
    expect(s.fields[0]).toMatchObject({ name: 'id', kind: 'id', nullable: false })
  })

  test('string() defaults to max 255; .max() overrides', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.string('email').max(320).unique()
    })
    const field = s.fields[0] as StringField
    expect(field.kind).toBe('string')
    expect(field.max).toBe(320)
    expect(field.unique).toBe(true)
  })

  test('modifiers stack: .nullable().default(...)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.integer('count').nullable().default(0)
    })
    expect(s.fields[0]).toMatchObject({
      name: 'count',
      kind: 'integer',
      nullable: true,
      hasDefault: true,
      default: 0,
    })
  })

  test('decimal() carries precision + scale', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.decimal('amount', 12, 2))
    const field = s.fields[0] as DecimalField
    expect(field).toMatchObject({ kind: 'decimal', precision: 12, scale: 2 })
  })

  test('enum() must have at least one value', () => {
    expect(() => defineSchema('x', Archetype.Entity, (t) => t.enum('s', []))).toThrow(/empty/)
  })

  test('enum() captures the value set', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.enum('status', ['a', 'b', 'c']))
    const field = s.fields[0] as EnumField
    expect(field.values).toEqual(['a', 'b', 'c'])
  })

  test('timestamp() defaults to withTimezone=true', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.timestamp('paid_at'))
    const field = s.fields[0] as TimestampField
    expect(field.withTimezone).toBe(true)
  })

  test('reference() captures target + onDelete', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const s = defineSchema('lead', Archetype.Entity, (t) => {
      t.id()
      t.foreign('user_id').to(user).onDelete('cascade')
    })
    const field = s.fields[1] as ReferenceField
    expect(field).toMatchObject({
      kind: 'reference',
      references: 'user',
      onDelete: 'cascade',
    })
  })
})

describe('SchemaBuilder — composite helpers', () => {
  test('timestamps() adds created_at + updated_at with now() default', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.timestamps()
    })
    const names = s.fields.map((f) => f.name)
    expect(names).toEqual(['id', 'created_at', 'updated_at'])
    for (const f of s.fields.slice(1)) {
      expect(f.hasDefault).toBe(true)
      expect(f.default).toEqual({ sql: 'now()' })
    }
  })

  test('softDeletes() adds nullable deleted_at', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.softDeletes()
    })
    expect(s.fields[1]).toMatchObject({ name: 'deleted_at', kind: 'timestamp', nullable: true })
  })

  test('timestamps() / softDeletes() are idempotent', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.timestamps()
      t.timestamps()
      t.softDeletes()
      t.softDeletes()
    })
    const counts = countByName(s.fields)
    expect(counts.created_at).toBe(1)
    expect(counts.updated_at).toBe(1)
    expect(counts.deleted_at).toBe(1)
  })
})

describe('SchemaBuilder — tenancy', () => {
  test('tenanted flag is captured on the schema', () => {
    const s = defineSchema('lead', Archetype.Entity, (t) => t.id(), { tenanted: true })
    expect(s.tenancy.tenanted).toBe(true)
  })

  test('tenantRegistry flag is captured', () => {
    const s = defineSchema('tenant', Archetype.Entity, (t) => t.id(), { tenantRegistry: true })
    expect(s.tenancy.tenantRegistry).toBe(true)
  })
})

function countByName(fields: readonly { name: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of fields) out[f.name] = (out[f.name] ?? 0) + 1
  return out
}
