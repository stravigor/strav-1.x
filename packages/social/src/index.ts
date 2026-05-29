// Public API of `@strav/social`.
//
// V1: provider-agnostic OAuth/OIDC client — normalized profile +
// token DTOs + multi-provider routing + state + PKCE helpers.
// Composes with `@strav/kernel` for the container and
// `@strav/http` (no direct import; for the eventual route helpers).
//
// Drivers ship as subpath imports:
//   `@strav/social/line`, `@strav/social/google`,
//   `@strav/social/facebook`. The `MockDriver` in `./drivers`
//   is for tests + as the reference contract.
//
// Account-linking schema lives in `./ledger/`:
//   - `social_account` tenanted table (tokens encrypted via
//     kernel's cipher)
//   - `SocialAccountRepository` with connect / disconnect /
//     find{ByUser,ByProviderIdentity} helpers
//   - `applySocialAccountMigration` for the table + composite
//     unique + user_id index

export type * from './dto/index.ts'
export { MockDriver, type MockDriverOptions, unsupported } from './drivers/index.ts'
export {
  applySocialAccountMigration,
  type ApplySocialAccountMigrationOptions,
  type ConnectInput,
  type DisconnectInput,
  SocialAccount,
  SocialAccountAlreadyLinkedError,
  SocialAccountRepository,
  socialAccountSchema,
} from './ledger/index.ts'
export {
  codeChallengeFor,
  randomCodeVerifier,
  randomState,
} from './pkce.ts'
export type { SocialCapability } from './social_capabilities.ts'
export type {
  AuthorizeInput,
  AuthorizeResult,
  ExchangeInput,
  RefreshInput,
  SocialDriver,
  SocialDriverFactory,
} from './social_driver.ts'
export {
  InvalidTokenError,
  OAuthExchangeError,
  ProviderUnsupportedError,
  SocialConfigError,
  SocialError,
  SocialProviderError,
  StateMismatchError,
  UnknownProviderError,
} from './social_error.ts'
export {
  SocialManager,
  type SocialManagerOptions,
} from './social_manager.ts'
export { SocialProvider } from './social_provider.ts'
export type { ProviderConfig, SocialConfig } from './types.ts'
