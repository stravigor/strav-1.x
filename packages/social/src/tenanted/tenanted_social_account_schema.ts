/**
 * `tenantedSocialAccountSchema` — opt-in tenant-scoped variant
 * of the social-account ledger. Imported from
 * `@strav/social/tenanted` so apps that don't need
 * multitenancy don't pay for it.
 *
 * Same columns as the default `socialAccountSchema`, with
 * `tenanted: true` so `@strav/database` injects the
 * `tenant_id` FK + RLS policy. Composite unique becomes
 * `(tenant_id, provider, provider_user_id)` — the same Google
 * account can be linked across distinct tenants (one per
 * tenant), but only once per tenant.
 *
 * Apps register this schema instead of (or alongside, under a
 * different name) the default. The matching `Model` +
 * `Repository` + `applyTenantedSocialAccountMigration` ship
 * here too so the wiring stays consistent.
 */

import { Archetype, defineSchema } from '@strav/database'

export const tenantedSocialAccountSchema = defineSchema(
  'social_account',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('user_id').max(64).notNull()
    t.string('provider').max(64).notNull()
    t.string('provider_user_id').max(255).notNull()
    t.string('email').max(320).nullable()
    t.string('name').max(255).nullable()
    t.string('avatar_url').max(1024).nullable()
    t.string('locale').max(16).nullable()
    t.encrypted('access_token').notNull()
    t.encrypted('refresh_token').nullable()
    t.encrypted('id_token').nullable()
    t.timestamp('expires_at').nullable()
    t.string('scope').max(512).nullable()
    t.json('metadata').notNull().default({})
    t.timestamp('created_at').notNull()
    t.timestamp('updated_at').notNull()
  },
  { tenanted: true },
)
