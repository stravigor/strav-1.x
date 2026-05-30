/**
 * Vendor-specific config shape for the broadcast channel.
 * Discriminator `driver: 'broadcast'` selects this factory.
 *
 * The channel has no provider-specific knobs — routing is decided
 * per-notification by `toBroadcast(notifiable)`'s returned `channel`
 * field. Apps using multiple broadcast backplanes (rare) wire two
 * channels at the manager level:
 *
 *   broadcast:     { driver: 'broadcast' }
 *   broadcast.alt: { driver: 'broadcast' }
 *
 * …and override `via()` on the notification to pick between them.
 * The shared `Broadcaster` token is resolved from the container.
 */

import type { ChannelConfig } from '../../notification_config.ts'

export interface BroadcastChannelConfig extends ChannelConfig {
  driver: 'broadcast'
}
