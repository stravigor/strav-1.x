/**
 * HMAC signing helpers for the webhook channel.
 *
 * Wire shape — Stripe-style canonical signature:
 *
 *   stringToSign = `${unixTimestampSeconds}.${rawJsonBody}`
 *   signature    = HMAC-{algo}(stringToSign, secret) as hex
 *   header       = `${algo}=${signature}`
 *
 * The leading timestamp in `stringToSign` is mandatory: it lets
 * receivers reject replays by comparing the signed `x-strav-timestamp`
 * against a tolerated window. Without it, a captured request body +
 * signature pair stays valid forever.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookSignatureAlgorithm } from './webhook_config.ts'

export function signWebhook(
  algorithm: WebhookSignatureAlgorithm,
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac(algorithm, secret).update(`${timestamp}.${body}`).digest('hex')
}

/**
 * Constant-time verification helper exported for receiver-side use.
 * Apps consuming `@strav/notification` webhooks call this on incoming
 * requests; rejects on length mismatch (short-circuit) and on byte
 * mismatch (timing-safe compare).
 */
export function verifyWebhookSignature(
  algorithm: WebhookSignatureAlgorithm,
  secret: string,
  timestamp: string,
  body: string,
  receivedSignatureHex: string,
): boolean {
  const expected = signWebhook(algorithm, secret, timestamp, body)
  if (expected.length !== receivedSignatureHex.length) return false
  return timingSafeEqual(
    new Uint8Array(Buffer.from(expected, 'utf-8')),
    new Uint8Array(Buffer.from(receivedSignatureHex, 'utf-8')),
  )
}
