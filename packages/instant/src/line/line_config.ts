/**
 * LINE-specific provider config.
 *
 * LINE splits the bot surface across two DIFFERENT channels in the
 * Developers Console; this config makes the split explicit so
 * apps don't accidentally point one channel's credentials at the
 * other endpoint.
 *
 *   1. **Messaging API channel.** Issues `channelAccessToken` +
 *      `channelSecret`. Authenticates push / reply / multicast /
 *      broadcast / rich-menu calls, and signs the
 *      `x-line-signature` webhook header.
 *
 *   2. **LINE Login channel.** A separate channel that LIFF apps
 *      are bound to. The `aud` claim on a LIFF ID token is THIS
 *      channel's id — not the Messaging channel's id. The
 *      `/oauth2/v2.1/verify` endpoint rejects tokens whose `aud`
 *      doesn't match the `client_id` it receives.
 *
 * Apps that don't use LIFF can omit `liff` entirely. Apps that
 * use LIFF must set `liff.channelId` to the **LINE Login channel
 * id** — copying the Messaging channel id here is the single most
 * common misconfiguration and will fail every verify call with an
 * audience mismatch.
 */

import type { ProviderConfig } from '../types.ts'

export interface LineProviderConfig extends ProviderConfig {
  driver: 'line'
  /** Messaging API channel access token. Authenticates send / push / reply / broadcast / rich-menu calls. */
  channelAccessToken: string
  /** Messaging API channel secret. HMAC-SHA256 key for `x-line-signature` webhook verification. */
  channelSecret: string
  /**
   * LIFF / LINE Login channel — only required if the app uses
   * LIFF. The `channelId` here MUST be the LINE Login channel id
   * that hosts the LIFF app, NOT the Messaging API channel id.
   */
  liff?: LineLiffConfig
  /** Override the Messaging API base URL (defaults to `https://api.line.me`). Useful in tests. */
  apiBaseURL?: string
  /** Override the data API base URL (defaults to `https://api-data.line.me`). Useful in tests. */
  dataApiBaseURL?: string
}

export interface LineLiffConfig {
  /**
   * LINE Login channel id (numeric string) — the `aud` claim on
   * every LIFF-issued ID token. Find it in the LINE Developers
   * Console under the LINE Login channel's "Basic settings"
   * tab, NOT the Messaging API channel.
   */
  channelId: string
}
