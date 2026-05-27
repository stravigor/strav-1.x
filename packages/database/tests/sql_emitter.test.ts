import { describe, expect, test } from 'bun:test'
import { isUlid } from '@strav/kernel'
import {
  Archetype,
  defineSchema,
  emitDeleteById,
  emitFindById,
  emitFindMany,
  emitInsert,
  emitUpdateById,
  quoteIdent,
  selectColumnList,
} from '../src/index.ts'

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.string('name')
  t.timestamp('email_verified_at').nullable()
  t.timestamps()
})

const noIdSchema = defineSchema('configuration', Archetype.Configuration, (t) => {
  t.string('key').unique()
  t.string('value')
})

describe('quoteIdent', () => {
  test('wraps in double-quotes', () => {
    expect(quoteIdent('email')).toBe('"email"')
  })
  test('escapes embedded double-quotes', () => {
    expect(quoteIdent('na"me')).toBe('"na""me"')
  })
})

describe('selectColumnList', () => {
  test('lists every column in declaration order', () => {
    expect(selectColumnList(userSchema)).toBe(
      '"id", "email", "name", "email_verified_at", "created_at", "updated_at"',
    )
  })
})

describe('emitInsert', () => {
  test('mints a ULID when id is absent on an `t.id()` schema', () => {
    const { sql, params } = emitInsert(userSchema, { email: 'a@b.com', name: 'Liva' })
    expect(sql).toBe('INSERT INTO "user" ("id", "email", "name") VALUES ($1, $2, $3) RETURNING *')
    expect(params).toHaveLength(3)
    expect(isUlid(params[0] as string)).toBe(true)
    expect(params[1]).toBe('a@b.com')
    expect(params[2]).toBe('Liva')
  })

  test('keeps a caller-supplied id', () => {
    const id = '01J0000000000000000000000A'
    const { sql, params } = emitInsert(userSchema, { id, email: 'a@b.com' })
    expect(sql).toBe('INSERT INTO "user" ("id", "email") VALUES ($1, $2) RETURNING *')
    expect(params).toEqual([id, 'a@b.com'])
  })

  test('omits undefined attrs so DB defaults fire (created_at, updated_at)', () => {
    const { sql } = emitInsert(userSchema, { email: 'a@b.com' })
    expect(sql).not.toContain('created_at')
    expect(sql).not.toContain('updated_at')
  })

  test('schema with no id field + no attrs → DEFAULT VALUES', () => {
    const { sql, params } = emitInsert(noIdSchema, {})
    expect(sql).toBe('INSERT INTO "configuration" DEFAULT VALUES RETURNING *')
    expect(params).toEqual([])
  })
})

describe('emitUpdateById', () => {
  test('updates only present columns + auto-bumps updated_at', () => {
    const { sql, params } = emitUpdateById(userSchema, 'u-1', { email: 'new@b.com' })
    expect(sql).toBe(
      'UPDATE "user" SET "email" = $1, "updated_at" = now() WHERE "id" = $2 RETURNING *',
    )
    expect(params).toEqual(['new@b.com', 'u-1'])
  })

  test('honors caller-supplied updated_at (no auto-bump)', () => {
    const when = new Date('2026-01-01T00:00:00Z')
    const { sql, params } = emitUpdateById(userSchema, 'u-1', { name: 'X', updated_at: when })
    expect(sql).toBe('UPDATE "user" SET "name" = $1, "updated_at" = $2 WHERE "id" = $3 RETURNING *')
    expect(params).toEqual(['X', when, 'u-1'])
  })

  test('schema without updated_at does not get an auto-bump', () => {
    const events = defineSchema('event', Archetype.Event, (t) => {
      t.id()
      t.string('kind')
      // No timestamps() — events typically only get created_at.
    })
    const { sql } = emitUpdateById(events, 'e-1', { kind: 'login' })
    expect(sql).not.toContain('updated_at')
  })

  test('throws when nothing would change', () => {
    expect(() => emitUpdateById(userSchema, 'u-1', {})).toThrow(/no changes/)
  })
})

describe('emitDeleteById', () => {
  test('parameterized DELETE by id', () => {
    const { sql, params } = emitDeleteById(userSchema, 'u-1')
    expect(sql).toBe('DELETE FROM "user" WHERE "id" = $1')
    expect(params).toEqual(['u-1'])
  })
})

describe('emitFindById', () => {
  test('selects every column LIMIT 1', () => {
    const { sql, params } = emitFindById(userSchema, 'u-1')
    expect(sql).toContain('SELECT "id", "email"')
    expect(sql).toContain('FROM "user" WHERE "id" = $1 LIMIT 1')
    expect(params).toEqual(['u-1'])
  })
})

describe('emitFindMany', () => {
  test('IN clause with one placeholder per id', () => {
    const { sql, params } = emitFindMany(userSchema, ['a', 'b', 'c'])
    expect(sql).toContain('WHERE "id" IN ($1, $2, $3)')
    expect(params).toEqual(['a', 'b', 'c'])
  })

  test('empty id list → always-false WHERE', () => {
    const { sql, params } = emitFindMany(userSchema, [])
    expect(sql).toContain('WHERE FALSE')
    expect(params).toEqual([])
  })
})
