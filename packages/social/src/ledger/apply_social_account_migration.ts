/**
 * `applySocialAccountMigration` — emit DDL for the
 * `social_account` table plus its composite unique constraints
 * and the `user_id` lookup index.
 *
 * Non-tenanted by default (framework policy: multitenancy is
 * opt-in). Apps that need per-tenant scoping use
 * `applyTenantedSocialAccountMigration` from
 * `@strav/social/tenanted` instead.
 *
 * Apps drop one call into their migration:
 *
 * ```ts
 * export const migration: Migration = {
 *   name: '20260601000000_create_social_account',
 *   async up(db) {
 *     await applySocialAccountMigration(db, { registry })
 *   },
 *   async down(db) {
 *     await db.execute(emitDropTable(socialAccountSchema.name).sql)
 *   },
 * }
 * ```
 */

import {
  emitCreateTable,
  type DatabaseExecutor,
  type SchemaRegistry,
} from '@strav/database'
import { socialAccountSchema } from './social_account_schema.ts'

export interface ApplySocialAccountMigrationOptions {
  /** Required for `emitCreateTable` to resolve relations. */
  registry: SchemaRegistry
}

export async function applySocialAccountMigration(
  db: DatabaseExecutor,
  options: ApplySocialAccountMigrationOptions,
): Promise<void> {
  const { registry } = options

  await db.execute(emitCreateTable(socialAccountSchema, { registry }).sql)

  // Provider-identity uniqueness — one Google / Line / Facebook
  // identity belongs to exactly one user. The sign-in lookup
  // (`findByProviderIdentity`) leans on this index.
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_provider_identity"
     ON "${socialAccountSchema.name}" ("provider", "provider_user_id")`,
  )

  // Per-user-per-provider uniqueness — a single user can only
  // link one account per provider.
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_social_account_user_provider"
     ON "${socialAccountSchema.name}" ("user_id", "provider")`,
  )

  // "All accounts for user" lookup — account-settings UI.
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_social_account_user"
     ON "${socialAccountSchema.name}" ("user_id")`,
  )
}
