// Public API of `@strav/social/tenanted` — the opt-in
// tenant-scoped variant of the social-account ledger.
//
// Apps that need per-tenant social accounts import from here.
// Default single-tenant apps stay on `@strav/social` and never
// pay for the extra column / RLS / `withTenant` wrapping.

export {
  applyTenantedSocialAccountMigration,
  type ApplyTenantedSocialAccountMigrationOptions,
} from './apply_tenanted_social_account_migration.ts'
export { TenantedSocialAccount } from './tenanted_social_account.ts'
export {
  type ConnectInput,
  type DisconnectInput,
  TenantedSocialAccountRepository,
} from './tenanted_social_account_repository.ts'
export { tenantedSocialAccountSchema } from './tenanted_social_account_schema.ts'
