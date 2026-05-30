/**
 * Vendor-specific config shape for the SSE channel. The
 * discriminator `driver: 'sse'` selects this factory at
 * `manager.use(...)` time.
 *
 * Unlike the broadcast channel, the SSE channel is a *pure in-process*
 * pub/sub registry — no `Broadcaster` peer, no Postgres LISTEN/NOTIFY.
 * One process, one registry; subscribers live on the same Bun instance
 * that dispatches the notification. Apps that need cross-process
 * fan-out wire the broadcast channel instead.
 *
 * When neither is appropriate (single-process apps that don't want a
 * pub/sub backplane at all), this is the simplest way to push a live
 * notification into a `router.sse(...)` handler.
 */

import type { ChannelConfig } from '../../notification_config.ts'

export interface SSEChannelConfig extends ChannelConfig {
  driver: 'sse'
  /**
   * Per-subscriber queue size. When a subscriber falls behind by
   * more than `queueSize` events, the oldest events are dropped
   * (best-effort delivery — the SSE contract anyway; clients
   * recover via `Last-Event-ID` on reconnect). Default `64`.
   */
  queueSize?: number
}
