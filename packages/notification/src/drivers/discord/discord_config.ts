/**
 * Vendor-specific config shape for the Discord channel. The
 * discriminator `driver: 'discord'` selects this factory at
 * `manager.use(...)` time.
 *
 * The Discord channel ships as a *webhook* driver — apps configure
 * one Discord webhook URL per channel and POST against it. Per-
 * recipient routing happens two ways:
 *
 *   1. Notifiables expose their own `discordWebhookUrl` field, and the
 *      driver uses it instead of the channel default.
 *   2. The notification's `toDiscord(notifiable)` hook returns a
 *      `{ webhookUrl, ... }` envelope that overrides both.
 *
 * Bot tokens / interaction-aware messaging is out of scope for this
 * slice — apps that need it bring their own integration and dispatch
 * through `manager.extend(name, factory)`.
 */

import type { ChannelConfig } from '../../notification_config.ts'

export interface DiscordChannelConfig extends ChannelConfig {
  driver: 'discord'
  /**
   * Default webhook URL. Optional — apps that route every dispatch
   * via per-recipient or per-notification URLs omit it. The driver
   * fails the dispatch (returns `delivered: false`, no error) when
   * neither the notification, the notifiable, nor the config supplies
   * a URL — same opt-out semantics as the mail / webhook channels.
   */
  webhookUrl?: string
  /**
   * Default username shown for messages sent via this channel. Apps
   * commonly set this to their product name. Per-message overrides
   * win — `toDiscord` can return `{ username: '...' }`.
   */
  username?: string
  /**
   * Default avatar URL. Same override rules as `username`.
   */
  avatarUrl?: string
  /**
   * When `true`, the driver appends `?wait=true` to the webhook URL.
   * Discord then responds 200 with the created message JSON instead
   * of 204 with an empty body — useful if downstream wants the
   * message ID via the dispatch result's `reference`. Default `false`.
   */
  wait?: boolean
  /** Request timeout in ms. Default `5000`. */
  timeoutMs?: number
}
