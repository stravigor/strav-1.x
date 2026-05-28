import { describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  defineSchema,
  emitTenantIdFunction,
  SchemaRegistry,
  validateTenantRegistry,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

class StubDb implements Database {
  /** Rows to return from queryOne — keyed by `${table}.${column}`. */
  scriptedColumns = new Map<
    string,
    { data_type: string; character_maximum_length: number | null }
  >()

  async query<T>(): Promise<T[]> {
    return []
  }
  async queryOne<T>(_sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const [table, column] = params as [string, string]
    const row = this.scriptedColumns.get(`${table}.${column}`)
    return (row as T | null) ?? null
  }
  async execute(): Promise<number> {
    return 0
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('StubDb.raw not implemented')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// validateTenantRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe('validateTenantRegistry', () => {
  test('no-op when no tenanted schemas are registered', async () => {
    const plain = defineSchema('plain', Archetype.Entity, (t) => t.id())
    const registry = new SchemaRegistry().registerAll([plain])
    const db = new StubDb()
    await expect(validateTenantRegistry(db, registry)).resolves.toBeUndefined()
  })

  test('throws when tenanted schemas exist but no tenantRegistry is declared', async () => {
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([post])
    const db = new StubDb()
    await expect(validateTenantRegistry(db, registry)).rejects.toThrow(/tenantRegistry: true/)
  })

  test('throws when multiple tenantRegistry schemas are declared', async () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.id(), {
      tenantRegistry: true,
    })
    const org = defineSchema('org', Archetype.Entity, (t) => t.id(), { tenantRegistry: true })
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([tenant, org, post])
    const db = new StubDb()
    await expect(validateTenantRegistry(db, registry)).rejects.toThrow(/multiple/)
  })

  test('throws when the registry table is missing from the live DB', async () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.id(), {
      tenantRegistry: true,
    })
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([tenant, post])
    const db = new StubDb()
    // No scripted row → queryOne returns null.
    await expect(validateTenantRegistry(db, registry)).rejects.toThrow(/not found in the live DB/)
  })

  test('passes when the registry exists with the matching PK type (char(26))', async () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.id(), {
      tenantRegistry: true,
    })
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([tenant, post])
    const db = new StubDb()
    db.scriptedColumns.set('tenant.id', {
      data_type: 'character',
      character_maximum_length: 26,
    })
    await expect(validateTenantRegistry(db, registry)).resolves.toBeUndefined()
  })

  test('passes for a uuid PK (matches without length)', async () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.uuid(), {
      tenantRegistry: true,
    })
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([tenant, post])
    const db = new StubDb()
    db.scriptedColumns.set('tenant.id', { data_type: 'uuid', character_maximum_length: null })
    await expect(validateTenantRegistry(db, registry)).resolves.toBeUndefined()
  })

  test('throws on PK-type mismatch (DB has uuid, schema declared char(26))', async () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.id(), {
      tenantRegistry: true,
    })
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([tenant, post])
    const db = new StubDb()
    db.scriptedColumns.set('tenant.id', { data_type: 'uuid', character_maximum_length: null })
    await expect(validateTenantRegistry(db, registry)).rejects.toThrow(
      /has type "uuid" in the DB, but the schema declared "char\(26\)"/,
    )
  })

  test('throws on length mismatch (varchar(50) vs varchar(255))', async () => {
    // Synthetic: a "registry" with a string PK at length 255.
    const tenant = defineSchema(
      'tenant',
      Archetype.Entity,
      (t) => {
        t.id() // char(26) PK
        t.string('email').max(255).unique()
      },
      { tenantRegistry: true },
    )
    const post = defineSchema('post', Archetype.Entity, (t) => t.id(), { tenanted: true })
    const registry = new SchemaRegistry().registerAll([tenant, post])
    const db = new StubDb()
    // Wrong observed length on the PK column.
    db.scriptedColumns.set('tenant.id', { data_type: 'character', character_maximum_length: 24 })
    await expect(validateTenantRegistry(db, registry)).rejects.toThrow(
      /has type "char\(24\)" in the DB/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// emitTenantIdFunction
// ─────────────────────────────────────────────────────────────────────────────

describe('emitTenantIdFunction', () => {
  test('emits a STABLE function returning the registry PK type (char(26) for t.id())', () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.id(), {
      tenantRegistry: true,
    })
    const registry = new SchemaRegistry().registerAll([tenant])
    const { sql } = emitTenantIdFunction(registry)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION current_tenant_id()')
    expect(sql).toContain('RETURNS char(26)')
    expect(sql).toContain(`current_setting('app.tenant_id', true)::char(26)`)
    expect(sql).toContain('LANGUAGE sql STABLE')
  })

  test('uuid PK → RETURNS uuid', () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.uuid(), {
      tenantRegistry: true,
    })
    const registry = new SchemaRegistry().registerAll([tenant])
    const { sql } = emitTenantIdFunction(registry)
    expect(sql).toContain('RETURNS uuid')
    expect(sql).toContain('::uuid')
  })

  test('bigSerial PK → RETURNS bigint (bigserial is a pseudo-type)', () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.bigSerial(), {
      tenantRegistry: true,
    })
    const registry = new SchemaRegistry().registerAll([tenant])
    const { sql } = emitTenantIdFunction(registry)
    expect(sql).toContain('RETURNS bigint')
    expect(sql).toContain('::bigint')
    expect(sql).not.toContain('bigserial')
  })

  test('throws when no tenantRegistry schema is registered', () => {
    const registry = new SchemaRegistry()
    expect(() => emitTenantIdFunction(registry)).toThrow(/tenantRegistry: true/)
  })
})
