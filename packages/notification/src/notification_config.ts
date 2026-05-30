/**
 * Notification configuration shape — what `config.notification` looks
 * like. Mirrors the manager-pattern config used by `@strav/payment`
 * and `@strav/social`: a `default` channel key + a `channels` map
 * keyed by name. Each channel entry carries its driver + driver-
 * specific options.
 *
 * `default` is OPTIONAL on this manager: notifications route per-call
 * via `via(notifiable)`, not via a single configured default. Apps
 * set `default` only when they want `manager.use()` (no arg) to
 * resolve to a specific channel.
 */

export interface NotificationConfig {
  /** Optional default channel name — must exist in `channels` when set. */
  default?: string
  /** Channel registry. Each entry is one configured backend. */
  channels: Record<string, ChannelConfig>
}

export interface ChannelConfig {
  /** Driver identifier — matches a registered factory (`mail`, `database`, `log`, or custom). */
  driver: string
  /** Free-form driver-specific fields. */
  [key: string]: unknown
}
