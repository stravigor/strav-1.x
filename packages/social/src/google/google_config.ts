/**
 * Google-specific provider config. Apps put one of these inside
 * `config.social.providers[name]` with `driver: 'google'`.
 *
 * Get credentials from https://console.cloud.google.com → APIs &
 * Services → Credentials → "OAuth 2.0 Client IDs". For server-
 * side apps choose "Web application"; for mobile / SPA see the
 * dedicated client types (PKCE is mandatory there).
 *
 * The Google Workspace `hd` (hosted-domain) constraint can be
 * enforced per-authorize via `authorize({ extra: { hd: 'example.com' } })`.
 */

import type { ProviderConfig } from '../types.ts'

export interface GoogleProviderConfig extends ProviderConfig {
  driver: 'google'
  clientId: string
  clientSecret: string
  /**
   * Default to requesting refresh tokens. Default `true`. When
   * `false`, the authorize URL omits `access_type=offline` and
   * `refresh()` will fail later — only useful for short-lived
   * "sign in once" flows where the app never holds long-term tokens.
   */
  offlineAccess?: boolean
  /** Override endpoints for testing — never set in production. */
  endpoints?: {
    authorize?: string
    token?: string
    userInfo?: string
    revoke?: string
    tokenInfo?: string
  }
  fetch?: typeof fetch
}

export const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  userInfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  revoke: 'https://oauth2.googleapis.com/revoke',
  tokenInfo: 'https://oauth2.googleapis.com/tokeninfo',
} as const
