/**
 * Line-specific provider config. Apps put one of these inside
 * `config.social.providers[name]` with `driver: 'line'`.
 *
 * Get credentials from https://developers.line.biz/console — a
 * Line Login channel under a provider. The `email` scope
 * additionally needs the "email permission" toggle to be enabled
 * inside the channel (Line approval required for production).
 */

import type { ProviderConfig } from '../../types.ts'

export interface LineProviderConfig extends ProviderConfig {
  driver: 'line'
  /** Channel ID from the Line Developers console. */
  clientId: string
  /** Channel secret from the Line Developers console. */
  clientSecret: string
  /**
   * Optional UI locale hint passed on every authorize URL —
   * `'th-TH'`, `'ja-JP'`, `'en-US'`, … Apps that route by user
   * locale override per-call via `authorize({ extra: { ui_locales } })`.
   * Defaults to Line's autodetect.
   */
  uiLocales?: string
  /** Override endpoints for testing — never set in production. */
  endpoints?: {
    authorize?: string
    token?: string
    profile?: string
    revoke?: string
    verify?: string
  }
  /**
   * Custom `fetch` override (tests). Defaults to global `fetch`.
   * The driver does no other I/O.
   */
  fetch?: typeof fetch
}

export const LINE_ENDPOINTS = {
  authorize: 'https://access.line.me/oauth2/v2.1/authorize',
  token: 'https://api.line.me/oauth2/v2.1/token',
  profile: 'https://api.line.me/v2/profile',
  revoke: 'https://api.line.me/oauth2/v2.1/revoke',
  verify: 'https://api.line.me/oauth2/v2.1/verify',
} as const
