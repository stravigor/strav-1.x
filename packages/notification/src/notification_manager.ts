/**
 * `NotificationManager` — the facade apps inject for sending
 * notifications.
 *
 * Two concept clusters:
 *
 *   - **Channels.** Apps declare configured channels in
 *     `config.notification.channels`. The manager constructs each
 *     channel driver lazily on first `use(name)` + memoizes. Custom
 *     channels register via `manager.extend(name, factory)`. Tests
 *     hand-wire via `manager.useDriver(name, driver)`.
 *
 *   - **Fan-out.** `send(notifiable, notification)` calls
 *     `notification.via(notifiable)` to get the channel list, then
 *     dispatches each channel in order, collecting per-channel
 *     `NotificationDeliveryResult`s into a single
 *     `NotificationDispatchResult`. Channels that throw are
 *     captured into the result (`delivered: false`, `error: ...`)
 *     — the manager never rethrows; apps inspect the result.
 *
 * One ULID per send shared across channels (for correlation in
 * downstream logs / persistence). The manager constructs the
 * `NotificationContext` once and threads it through.
 */

import { ulid } from '@strav/kernel'
import type { Notifiable } from './notifiable.ts'
import type { BaseNotification } from './notification.ts'
import type { NotificationConfig } from './notification_config.ts'
import type { NotificationDriver, NotificationDriverFactory } from './notification_driver.ts'
import { NotificationConfigError, UnknownChannelError } from './notification_error.ts'
import type {
  NotificationContext,
  NotificationDeliveryResult,
  NotificationDispatchResult,
} from './types.ts'

export interface NotificationManagerOptions {
  config: NotificationConfig
}

export class NotificationManager {
  readonly config: NotificationConfig

  private readonly drivers = new Map<string, NotificationDriver>()
  private readonly extensions = new Map<string, NotificationDriverFactory>()

  constructor(options: NotificationManagerOptions) {
    const { config } = options
    if (config.default !== undefined && !config.channels[config.default]) {
      throw new NotificationConfigError(
        `NotificationManager: default channel "${config.default}" is not configured.`,
        {
          context: {
            default: config.default,
            available: Object.keys(config.channels),
          },
        },
      )
    }
    this.config = config
  }

  // ─── Channel routing ──────────────────────────────────────────────────

  /** Resolve a channel by name (or the default when omitted). */
  use(name?: string): NotificationDriver {
    const key = name ?? this.config.default
    if (key === undefined) {
      throw new NotificationConfigError(
        'NotificationManager.use(): no name given and no default channel is configured.',
      )
    }
    const cached = this.drivers.get(key)
    if (cached) return cached

    const cfg = this.config.channels[key]
    if (!cfg) {
      throw new UnknownChannelError(`NotificationManager: channel "${key}" is not configured.`, {
        context: { requested: key, available: Object.keys(this.config.channels) },
      })
    }

    const factory = this.extensions.get(cfg.driver)
    if (!factory) {
      throw new UnknownChannelError(
        `NotificationManager: unknown driver "${cfg.driver}" for channel "${key}". Register it via \`manager.extend("${cfg.driver}", factory)\`.`,
        { context: { driver: cfg.driver, available: [...this.extensions.keys()] } },
      )
    }
    const driver = factory({ instanceName: key, config: cfg })
    this.drivers.set(key, driver)
    return driver
  }

  /** Register a channel driver factory. Adapter packages call this from their ServiceProvider. */
  extend(driverName: string, factory: NotificationDriverFactory): void {
    this.extensions.set(driverName, factory)
  }

  /** Hand-wire a channel instance under an app-chosen name (tests / one-offs). */
  useDriver(instanceName: string, driver: NotificationDriver): void {
    this.drivers.set(instanceName, driver)
  }

  // ─── Fan-out ──────────────────────────────────────────────────────────

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
  ): Promise<NotificationDispatchResult> {
    const context: NotificationContext = {
      id: ulid(),
      dispatchedAt: new Date(),
    }
    const channels = notification.via(notifiable)
    const deliveries: NotificationDeliveryResult[] = []

    for (const channelName of channels) {
      try {
        const driver = this.use(channelName)
        const result = await driver.send(notifiable, notification, context)
        deliveries.push(result)
      } catch (err) {
        deliveries.push({
          channel: channelName,
          delivered: false,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    }

    return { id: context.id, deliveries }
  }
}
