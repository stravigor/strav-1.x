/**
 * `OAuthTokens` — normalized token payload from a successful
 * code exchange or refresh. Apps persist these against their
 * user record (encrypted via `@strav/kernel`'s cipher).
 *
 * `idToken` is set only for OIDC providers (Google, Line as
 * OpenID Connect). Plain-OAuth2 providers (Facebook) leave it
 * undefined.
 *
 * `expiresAt` is provider-derived (`expires_in` seconds → wall
 * clock). Drivers compute it at exchange time so apps don't
 * need to track when the call was made.
 */

export interface OAuthTokens {
  accessToken: string
  /** Available only when the user granted offline access (Google) or the provider issues refresh tokens by default (Line). */
  refreshToken?: string
  /** OIDC id_token (JWT). Present on `openid` flows. Apps that already trust the access token usually ignore this. */
  idToken?: string
  expiresAt?: Date
  /** Space-separated scope string the provider granted (may be narrower than what was requested). */
  scope?: string
  tokenType: string
  raw: unknown
}
