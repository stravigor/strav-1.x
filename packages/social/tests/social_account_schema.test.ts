/**
 * Slice 8.5 — ledger structural smoke tests (no DB required).
 *
 *   - Migration helper emits all expected DDL fragments.
 *   - Schema declares the right columns + tenanting flag.
 *   - `SocialAccountAlreadyLinkedError` carries the right context.
 *
 * Real-DB integration (encryption round-trip, RLS scoping, the
 * connect/disconnect/findByProviderIdentity sign-in flow) lives
 * in the m7-social e2e (slice 8.6).
 */

import { describe, expect, test } from 'bun:test'
import { Archetype, type DatabaseExecutor, defineSchema, SchemaRegistry } from '@strav/database'
import {
  applySocialAccountMigration,
  SocialAccount,
  SocialAccountAlreadyLinkedError,
  socialAccountSchema,
} from '../src/index.ts'
import {
  applyTenantedSocialAccountMigration,
  TenantedSocialAccount,
  tenantedSocialAccountSchema,
} from '../src/tenanted/index.ts'

interface Executed {
  sql: string
  params?: readonly unknown[]
}

function collectingExecutor(): { exec: DatabaseExecutor; statements: Executed[] } {
  const statements: Executed[] = []
  const exec = {
    async execute(sql: string, params?: readonly unknown[]): Promise<void> {
      statements.push({ sql, ...(params !== undefined ? { params } : {}) })
    },
    async query(): Promise<never[]> {
      return []
    },
    async queryOne(): Promise<null> {
      return null
    },
  } as unknown as DatabaseExecutor
  return { exec, statements }
}

describe('socialAccountSchema (default — non-tenanted)', () => {
  test('declares the expected column names, NOT tenanted', () => {
    const names = socialAccountSchema.fields.map((f) => f.name).sort()
    for (const expected of [
      'access_token',
      'avatar_url',
      'created_at',
      'email',
      'expires_at',
      'id',
      'id_token',
      'locale',
      'metadata',
      'name',
      'provider',
      'provider_user_id',
      'refresh_token',
      'scope',
      'updated_at',
      'user_id',
    ]) {
      expect(names).toContain(expected)
    }
    // Framework policy: multitenancy is opt-in.
    expect(socialAccountSchema.tenancy?.tenanted).toBeFalsy()
  })

  test('token columns are emitted as the framework `encrypted` kind', () => {
    const byName = new Map(socialAccountSchema.fields.map((f) => [f.name, f]))
    for (const f of ['access_token', 'refresh_token', 'id_token']) {
      expect(byName.get(f)?.kind).toBe('encrypted')
    }
  })

  test('SocialAccount model points at the schema', () => {
    expect(SocialAccount.schema).toBe(socialAccountSchema)
  })
})

describe('applySocialAccountMigration (default — non-tenanted)', () => {
  test('emits CREATE TABLE + provider-identity unique + user_provider unique + user index', async () => {
    const { exec, statements } = collectingExecutor()
    const registry = new SchemaRegistry().registerAll([socialAccountSchema])
    await applySocialAccountMigration(exec, { registry })
    const sqls = statements.map((s) => s.sql).join('\n')
    expect(sqls).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_provider_identity"')
    expect(sqls).toContain('"provider", "provider_user_id"')
    expect(sqls).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_user_provider"')
    expect(sqls).toContain('CREATE INDEX IF NOT EXISTS "idx_social_account_user"')
    // Non-tenanted variant must not mention tenant_id.
    expect(sqls).not.toContain('tenant_id')
  })
})

describe('tenantedSocialAccountSchema (opt-in)', () => {
  test('declares the same columns as the default schema, plus tenanted: true', () => {
    const defaultCols = new Set(socialAccountSchema.fields.map((f) => f.name))
    const tenantedCols = new Set(tenantedSocialAccountSchema.fields.map((f) => f.name))
    for (const c of defaultCols) expect(tenantedCols.has(c)).toBe(true)
    expect(tenantedSocialAccountSchema.tenancy?.tenanted).toBe(true)
    expect(TenantedSocialAccount.schema).toBe(tenantedSocialAccountSchema)
  })
})

describe('applyTenantedSocialAccountMigration (opt-in)', () => {
  test('emits tenant-scoped composite unique on (tenant_id, provider, provider_user_id)', async () => {
    const { exec, statements } = collectingExecutor()
    const tenantSchema = defineSchema(
      'tenant',
      Archetype.Entity,
      (t) => {
        t.id()
        t.string('name').max(120)
      },
      { tenantRegistry: true },
    )
    const registry = new SchemaRegistry().registerAll([
      tenantSchema,
      tenantedSocialAccountSchema,
    ])
    await applyTenantedSocialAccountMigration(exec, { registry })
    const sqls = statements.map((s) => s.sql).join('\n')
    expect(sqls).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_tenant_identity"')
    expect(sqls).toContain('"tenant_id", "provider", "provider_user_id"')
    expect(sqls).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_user_provider"')
    expect(sqls).toContain('CREATE INDEX IF NOT EXISTS "idx_social_account_user"')
  })
})

describe('SocialAccountAlreadyLinkedError', () => {
  test('carries provider + identity + both user ids on the error', () => {
    const err = new SocialAccountAlreadyLinkedError({
      provider: 'line',
      providerUserId: 'U1234567890abcdef',
      existingUserId: 'user_a',
      attemptedUserId: 'user_b',
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SocialAccountAlreadyLinkedError')
    expect(err.provider).toBe('line')
    expect(err.providerUserId).toBe('U1234567890abcdef')
    expect(err.existingUserId).toBe('user_a')
    expect(err.attemptedUserId).toBe('user_b')
    expect(err.message).toContain('user_a')
    expect(err.message).toContain('user_b')
  })
})
