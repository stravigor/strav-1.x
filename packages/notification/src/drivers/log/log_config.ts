/**
 * Vendor-specific config shape for the log channel. The discriminator
 * `driver: 'log'` selects this factory at `manager.use(...)` time.
 */

import type { ChannelConfig } from '../../notification_config.ts'

export interface LogChannelConfig extends ChannelConfig {
  driver: 'log'
  /** Log level for this channel. Default `'info'`. */
  level?: 'info' | 'warn' | 'error'
}
