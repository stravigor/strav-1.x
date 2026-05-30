/**
 * Omise-specific provider config.
 */

import type { ProviderConfig } from '../../types.ts'

export interface OmiseProviderConfig extends ProviderConfig {
  driver: 'omise'
  /** `pkey_test_...` / `pkey_live_...` — required for client-side token issuance. */
  publicKey: string
  /** `skey_test_...` / `skey_live_...` — required for the server-side API. */
  secretKey: string
  /** Webhook signing secret from the Omise Dashboard. Required for the webhook route. */
  webhookSecret?: string
  /** Pin the Omise API version (e.g. `'2019-05-29'`). */
  omiseVersion?: string
  /** Optional: pass a pre-built `Omise` instance (tests). */
  client?: unknown
}
