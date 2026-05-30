/**
 * Vendor-specific config shape for the webhook channel. The
 * discriminator `driver: 'webhook'` selects this factory at
 * `manager.use(...)` time.
 */

import type { ChannelConfig } from '../../notification_config.ts'

export type WebhookSignatureAlgorithm = 'sha256' | 'sha1' | 'sha512'

export interface WebhookChannelConfig extends ChannelConfig {
  driver: 'webhook'
  /**
   * Endpoint URL to POST notifications to. Required at the config
   * level — apps that need per-recipient routing register multiple
   * webhook channels and pick between them in `notification.via()`.
   */
  endpoint: string
  /**
   * HMAC secret used to sign every request. Required. Pull from env
   * in `config/notification.ts`; never hard-code. Rotating the secret
   * requires coordinating with every receiver.
   */
  secret: string
  /**
   * Hash algorithm for the HMAC. Default `'sha256'`. Receivers should
   * compute against the same algorithm — the algorithm name is also
   * sent as the prefix on the `x-strav-signature` header so receivers
   * can validate during rotations.
   */
  algorithm?: WebhookSignatureAlgorithm
  /**
   * Headers added to every request. Merge order: built-in (`x-strav-*`,
   * `content-type`) → these → per-request override is NOT supported (the
   * notification only contributes the body, not the transport metadata).
   * Useful for auth tokens the receiver requires in addition to the
   * HMAC signature (a fixed `Authorization` header on the receiving
   * service, an `x-tenant-id`, etc.).
   */
  headers?: Record<string, string>
  /** Request timeout in ms. Default `5000`. */
  timeoutMs?: number
}
