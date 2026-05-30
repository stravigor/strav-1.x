/**
 * Per-send metadata. The manager constructs one on every `send()` call
 * and threads it through each channel driver. Apps can use the
 * `idempotencyKey` to deduplicate downstream (e.g. preventing the
 * database channel from inserting two rows for the same retry).
 */
export interface NotificationContext {
  /** ULID — stable per send, shared across channels. */
  id: string
  dispatchedAt: Date
  /** App-supplied idempotency key. Optional. */
  idempotencyKey?: string
}

/**
 * Outcome a channel driver reports back. The manager aggregates these
 * into a `NotificationDispatchResult` so apps can branch on per-channel
 * success / failure without each driver having to throw.
 */
export interface NotificationDeliveryResult {
  channel: string
  delivered: boolean
  /** Driver-specific reference (mail message id, database row id, etc.). */
  reference?: string
  /** Set when `delivered === false`. */
  error?: Error
}

export interface NotificationDispatchResult {
  /** Notification ULID — matches `NotificationContext.id`. */
  id: string
  /** One entry per channel attempted, in the order `via()` returned them. */
  deliveries: readonly NotificationDeliveryResult[]
}
