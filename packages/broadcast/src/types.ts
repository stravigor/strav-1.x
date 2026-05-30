/**
 * Public types for `@strav/broadcast`.
 *
 * The wire shape of a published event is intentionally tiny — `event`
 * (a verb tag) + `data` (JSON-serialisable payload) + `id` (assigned by
 * the publisher so receivers can dedup / replay). Driver implementations
 * round-trip this shape verbatim; bigger wire metadata (timestamps,
 * sender IDs, etc.) ride on `data` rather than getting promoted to
 * separate fields here.
 */

export interface BroadcastEvent {
  /**
   * Event name — a verb tag like `'invoice.paid'` or `'message.created'`.
   * Receivers branch on this; keep it stable.
   */
  event: string
  /** JSON-serialisable payload. Must round-trip through `JSON.stringify`. */
  data: unknown
  /**
   * Publisher-assigned identifier. ULIDs are the recommended shape —
   * monotonically ordered, globally unique. Receivers use this to
   * dedup retried deliveries and to seed `Last-Event-ID` replay on
   * SSE reconnects.
   */
  id: string
}

/**
 * Callback / async iterator interaction is wrapped by the
 * `Broadcaster.subscribe()` return value. Subscribers consume events
 * via `for await (const event of subscription) { ... }` and call
 * `subscription.return()` (or break out of the loop) to unsubscribe.
 */
export interface BroadcastSubscription extends AsyncIterableIterator<BroadcastEvent> {
  /** Unsubscribe + release driver resources. Idempotent. */
  unsubscribe(): Promise<void>
}
