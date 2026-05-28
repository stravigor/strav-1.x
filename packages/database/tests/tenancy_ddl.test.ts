import { describe, expect, test } from 'bun:test'
import {
  Archetype,
  defineSchema,
  emitCreateTable,
  emitRlsForTenanted,
  SchemaRegistry,
  tenantIdColumnName,
  tenantRegistrySchema,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const tenantSchema = defineSchema('tenant', Archetype.Entity, (t) => t.id(), {
  tenantRegistry: true,
})
const orgSchema = defineSchema('org', Archetype.Entity, (t) => t.uuid(), {
  tenantRegistry: true,
})
const numericTenantSchema = defineSchema('tenant', Archetype.Entity, (t) => t.bigSerial(), {
  tenantRegistry: true,
})

const postSchema = defineSchema(
  'post',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('title')
    t.timestamps()
  },
  { tenanted: true },
)

// ─────────────────────────────────────────────────────────────────────────────
// tenantRegistrySchema
// ─────────────────────────────────────────────────────────────────────────────

describe('tenantRegistrySchema', () => {
  test('returns the registered tenantRegistry schema', () => {
    const registry = new SchemaRegistry().registerAll([tenantSchema, postSchema])
    expect(tenantRegistrySchema(registry).name).toBe('tenant')
  })

  test('throws when no SchemaRegistry is passed', () => {
    expect(() => tenantRegistrySchema(undefined)).toThrow(/SchemaRegistry is required/)
  })

  test('throws when no schema is flagged tenantRegistry', () => {
    const registry = new SchemaRegistry().registerAll([postSchema])
    expect(() => tenantRegistrySchema(registry)).toThrow(/tenantRegistry: true/)
  })
})

describe('tenantIdColumnName', () => {
  test('derives from the registry table name', () => {
    expect(tenantIdColumnName(tenantSchema)).toBe('tenant_id')
    expect(tenantIdColumnName(orgSchema)).toBe('org_id')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// emitRlsForTenanted
// ─────────────────────────────────────────────────────────────────────────────

describe('emitRlsForTenanted', () => {
  test('emits ENABLE RLS + a CREATE POLICY scoped by app.tenant_id (text PK)', () => {
    const registry = new SchemaRegistry().registerAll([tenantSchema, postSchema])
    const sql = emitRlsForTenanted(postSchema, registry)
    expect(sql).toContain('ALTER TABLE "post" ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('CREATE POLICY "post_tenant_isolation" ON "post"')
    expect(sql).toContain(`"tenant_id" = current_setting('app.tenant_id')::char(26)`)
    expect(sql).toContain('USING')
    expect(sql).toContain('WITH CHECK')
  })

  test('casts to the tenant registry PK type — uuid', () => {
    const registry = new SchemaRegistry().registerAll([orgSchema, postSchema])
    const sql = emitRlsForTenanted(postSchema, registry)
    expect(sql).toContain('"org_id" = current_setting(')
    expect(sql).toContain(`::uuid`)
  })

  test('casts to bigint when the tenant PK is bigSerial', () => {
    const registry = new SchemaRegistry().registerAll([numericTenantSchema, postSchema])
    const sql = emitRlsForTenanted(postSchema, registry)
    expect(sql).toContain(`::bigint`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// emitCreateTable for tenanted schemas
// ─────────────────────────────────────────────────────────────────────────────

describe('emitCreateTable — tenanted: true', () => {
  test('injects the tenant_id column right after the PK + appends RLS statements', () => {
    const registry = new SchemaRegistry().registerAll([tenantSchema, postSchema])
    const { sql } = emitCreateTable(postSchema, { registry })

    // Single combined SQL string — Database.execute handles multi-statement.
    expect(sql).toMatch(
      /CREATE TABLE "post" \([\s\S]+\);\nALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\nCREATE POLICY/,
    )

    // Column order: id, tenant_id, then the rest in declaration order.
    // Searching the full SQL works because the column-name substrings (like
    // `"id"`) only appear once on the left-hand-side of a column line; the
    // RLS suffix references them by quoted identifier inside CREATE POLICY
    // too, but those instances come AFTER all column lines anyway.
    const positions = ['"id"', '"tenant_id"', '"title"', '"created_at"', '"updated_at"'].map((c) =>
      sql.indexOf(c),
    )
    expect(positions.every((p) => p > 0)).toBe(true)
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1]
      const cur = positions[i]
      if (prev === undefined || cur === undefined) throw new Error('unreachable')
      expect(cur).toBeGreaterThan(prev)
    }
  })

  test('tenant_id column adopts the registry PK type + ON DELETE CASCADE', () => {
    const registry = new SchemaRegistry().registerAll([tenantSchema, postSchema])
    const { sql } = emitCreateTable(postSchema, { registry })
    expect(sql).toContain(
      '"tenant_id" char(26) NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE',
    )
  })

  test('honors a uuid tenant PK', () => {
    const registry = new SchemaRegistry().registerAll([orgSchema, postSchema])
    const { sql } = emitCreateTable(postSchema, { registry })
    expect(sql).toContain('"org_id" uuid NOT NULL REFERENCES "org" ("id") ON DELETE CASCADE')
  })

  test('non-tenanted schemas are emitted unchanged — no RLS, no tenant_id', () => {
    const plain = defineSchema('plain', Archetype.Entity, (t) => {
      t.id()
      t.string('name')
    })
    const registry = new SchemaRegistry().registerAll([tenantSchema, plain])
    const { sql } = emitCreateTable(plain, { registry })
    expect(sql).not.toContain('tenant_id')
    expect(sql).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('CREATE POLICY')
  })

  test('throws when tenanted: true but no tenant registry is in the registry', () => {
    const registry = new SchemaRegistry().registerAll([postSchema])
    expect(() => emitCreateTable(postSchema, { registry })).toThrow(/tenantRegistry: true/)
  })

  test('throws when no registry is supplied for a tenanted schema', () => {
    expect(() => emitCreateTable(postSchema)).toThrow(/SchemaRegistry is required/)
  })
})
