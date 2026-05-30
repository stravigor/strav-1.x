import type { ChannelConfig } from '../../notification_config.ts'

export interface MailChannelConfig extends ChannelConfig {
  driver: 'mail'
  /** Optional named transport — passed through to `MailManager.via(name)`. */
  transport?: string
}
