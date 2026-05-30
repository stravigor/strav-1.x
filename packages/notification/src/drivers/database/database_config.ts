import type { ChannelConfig } from '../../notification_config.ts'

export interface DatabaseChannelConfig extends ChannelConfig {
  driver: 'database'
  /** Force tenanted variant. Default: non-tenanted (framework policy: opt-in). */
  tenanted?: boolean
}
