/**
 * `applyTenantedSocialAccountMigration` — DDL for the opt-in
 * tenanted variant of the social-account ledger.
 *
 * Composite unique becomes `(tenant_id, provider,
 * provider_user_id)` — the same Google account can be linked
 * once per tenant. The `user_id` index serves the "all
 * accounts for user" lookup.
 */

import {
  emitCreateTable,
  type DatabaseExecutor,
  type SchemaRegistry,
} from '@strav/database'
import { tenantedSocialAccountSchema } from './tenanted_social_account_schema.ts'

export interface ApplyTenantedSocialAccountMigrationOptions {
  /** Required for `emitCreateTable` to resolve the tenant FK ref. */
  registry: SchemaRegistry
}

export async function applyTenantedSocialAccountMigration(
  db: DatabaseExecutor,
  options: ApplyTenantedSocialAccountMigrationOptions,
): Promise<void> {
  const { registry } = options

  await db.execute(emitCreateTable(tenantedSocialAccountSchema, { registry }).sql)

  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_tenant_identity"
     ON "${tenantedSocialAccountSchema.name}" ("tenant_id", "provider", "provider_user_id")`,
  )

  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_user_provider"
     ON "${tenantedSocialAccountSchema.name}" ("user_id", "provider")`,
  )

  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_social_account_user"
     ON "${tenantedSocialAccountSchema.name}" ("user_id")`,
  )
}
