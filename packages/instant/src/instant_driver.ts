/**
 * `InstantDriver` — the driver contract every adapter implements.
 *
 * One driver represents a configured provider instance
 * (`config.instant.providers['line']`). The manager holds one
 * driver per configured name and routes send / reply / webhook
 * calls into it.
 *
 * Methods drivers don't support throw `ProviderUnsupportedError`
 * synchronously. The driver's `capabilities` set declares the
 * supported surfaces — apps that branch on capability avoid the
 * throw by checking first.
 */

import type { InstantCapability } from './instant_capabilities.ts'
import type { OutgoingMessage, SendResult } from './message.ts'
import type { WebhookEvent } from './webhook_event.ts'

/**
 * Inbound webhook verification + parsing. Drivers that lack a
 * webhook surface (rare for an instant-messaging provider)
 * declare neither `webhook.signature` nor `webhook.parse` and
 * throw `ProviderUnsupportedError` from these methods.
 */
export interface WebhookOps {
  /**
   * Verify the provider signature against the raw request body.
   * Returns `true` when the signature matches. Drivers throw
   * `WebhookSignatureError` only when the header is missing /
   * malformed; a clean mismatch returns `false` so the route
   * can decide how to respond.
   */
  verifySignature(rawBody: string, signature: string | null | undefined): boolean
  /**
   * Parse a verified raw body into the framework's normalized
   * `WebhookEvent` union. Drivers translate every event variant
   * they can recognise; unknown shapes map to `{ type: 'unknown', raw }`.
   */
  parse(rawBody: string): WebhookEvent[]
}

/**
 * Optional profile lookup. LINE / Messenger / WhatsApp all expose
 * a "get user profile by id" endpoint with diverging fields;
 * the driver returns whatever it can fill.
 */
export interface UserProfile {
  userId: string
  displayName?: string
  pictureUrl?: string
  statusMessage?: string
  language?: string
  raw?: unknown
}

export interface InstantDriver {
  /** Driver identifier — matches the `driver:` discriminator in `ProviderConfig`. */
  readonly name: string
  /** App-chosen instance name (`config.instant.providers[name]`). */
  readonly instanceName: string
  /** Declared feature set. Apps check this to branch around `ProviderUnsupportedError`. */
  readonly capabilities: ReadonlySet<InstantCapability>

  /**
   * Send a message to a single recipient. Whether this uses the
   * provider's "push" endpoint, "send" endpoint, or a reply
   * window is provider-defined; the common shape is "I have a
   * recipient id, deliver this message."
   */
  send(to: string, message: OutgoingMessage): Promise<SendResult>

  /**
   * Reply to an inbound event within the provider's reply
   * window. `replyToken` is provider-issued (LINE reply token,
   * WhatsApp context message id, …).
   */
  reply?(replyToken: string, message: OutgoingMessage): Promise<SendResult>

  /** Push to a recipient outside a reply window. Distinct from `send` only on providers that distinguish. */
  push?(to: string, message: OutgoingMessage): Promise<SendResult>

  /** Multicast — same message to many recipients. */
  multicast?(to: readonly string[], message: OutgoingMessage): Promise<SendResult>

  /** Broadcast — same message to every follower. */
  broadcast?(message: OutgoingMessage): Promise<SendResult>

  /** Fetch a profile from the provider. */
  profile?(userId: string): Promise<UserProfile>

  readonly webhook: WebhookOps
}

/** Factory the manager invokes for each configured provider. */
export type InstantDriverFactory = (config: {
  /** App-chosen instance name (`'line'`, `'line-marketing'`, …). */
  instanceName: string
  /** Provider-config object with `driver:` + driver-specific fields. */
  config: Record<string, unknown> & { driver: string }
}) => InstantDriver
