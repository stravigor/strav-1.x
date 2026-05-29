/**
 * `SocialCapability` — feature flags every driver declares.
 *
 * Apps that build account-connect UI check these to gate buttons
 * / scopes / refresh-token flows. Drivers omit a flag when they
 * can't fulfil it faithfully — partial / surprising behaviour is
 * worse than `ProviderUnsupportedError`.
 *
 * Granularity is intentionally fine: e.g. Facebook supports
 * `tokens.refresh` only for long-lived tokens issued by the Pages
 * API path, so v1 marks it unsupported; Line supports it
 * uniformly.
 */

export type SocialCapability =
  // OIDC vs plain OAuth2
  | 'openid' // returns an id_token + nonce flow
  | 'pkce.support' // accepts PKCE (codeChallenge / codeVerifier)
  | 'pkce.required' // mandates PKCE (Google)
  // Profile data we can normalize
  | 'profile.id'
  | 'profile.email'
  | 'profile.emailVerified'
  | 'profile.name'
  | 'profile.avatar'
  | 'profile.locale'
  // Token operations
  | 'tokens.exchange'
  | 'tokens.refresh'
  | 'tokens.revoke'
  | 'tokens.introspect'
  // Scopes — each driver exposes its supported list separately
  // via `driver.availableScopes`, but the flag here gates
  // "scope picker UI" generation.
  | 'scopes.discoverable'
