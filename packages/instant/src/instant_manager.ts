/**
 * `InstantManager` — the facade apps use for instant-messaging
 * workflows.
 *
 * Mirrors the manager-pattern shared with `@strav/payment` and
 * `@strav/notification`:
 *
 *   - **Drivers.** Apps declare providers in
 *     `config.instant.providers`. The manager constructs each
 *     driver lazily on first `use(name)` + memoizes. Adapter
 *     packages register their factories via
 *     `manager.extend(name, factory)`.
 *
 *   - **Default routing.** `manager.send(to, msg)` routes to the
 *     default driver. `manager.use('marketing').send(...)`
 *     targets a named one.
 *
 *   - **Webhooks.** `manager.verify(provider, rawBody, sig)` and
 *     `manager.parseWebhook(provider, rawBody)` delegate into the
 *     driver's `WebhookOps`. Apps wire these into their HTTP
 *     route (one route per provider).
 */

import { InstantConfigError, UnknownProviderError } from './errors.ts'
import type { InstantDriver, InstantDriverFactory } from './instant_driver.ts'
import type { OutgoingMessage, SendResult } from './message.ts'
import type { InstantConfig, ProviderConfig } from './types.ts'
import type { WebhookEvent } from './webhook_event.ts'

export interface InstantManagerOptions {
  config: InstantConfig
}

export class InstantManager {
  readonly config: InstantConfig

  private readonly drivers = new Map<string, InstantDriver>()
  private readonly extensions = new Map<string, InstantDriverFactory>()

  constructor(options: InstantManagerOptions) {
    const { config } = options
    if (!config.providers[config.default]) {
      throw new InstantConfigError(
        `InstantManager: default provider "${config.default}" is not configured.`,
        {
          context: {
            default: config.default,
            available: Object.keys(config.providers),
          },
        },
      )
    }
    this.config = config
  }

  // ─── Driver routing ──────────────────────────────────────────────────

  /** Resolve a driver by app-chosen instance name (or the default when omitted). */
  use(name?: string): InstantDriver {
    const key = name ?? this.config.default
    const cached = this.drivers.get(key)
    if (cached) return cached

    const cfg = this.config.providers[key]
    if (!cfg) {
      throw new UnknownProviderError(key, Object.keys(this.config.providers))
    }
    const ext = this.extensions.get(cfg.driver)
    if (!ext) {
      throw new InstantConfigError(
        `InstantManager: unknown driver "${cfg.driver}" for provider "${key}". Register it via \`manager.extend("${cfg.driver}", factory)\` or install the matching adapter package.`,
        { context: { driver: cfg.driver, available: [...this.extensions.keys()] } },
      )
    }
    const driver = ext({
      instanceName: key,
      config: cfg as ProviderConfig & { driver: string },
    })
    this.drivers.set(key, driver)
    return driver
  }

  /**
   * Register a driver factory. Adapter packages call this from
   * their ServiceProvider's `register()` step.
   */
  extend(driverName: string, factory: InstantDriverFactory): void {
    this.extensions.set(driverName, factory)
  }

  /** Hand-wire a driver instance under an app-chosen name (tests / one-offs). */
  useDriver(instanceName: string, driver: InstantDriver): void {
    this.drivers.set(instanceName, driver)
  }

  // ─── Convenience delegates to the default driver ─────────────────────

  send(to: string, message: OutgoingMessage): Promise<SendResult> {
    return this.use().send(to, message)
  }

  // ─── Webhook routing ─────────────────────────────────────────────────

  /** Verify a webhook signature using the named provider's driver. */
  verify(provider: string, rawBody: string, signature: string | null | undefined): boolean {
    return this.use(provider).webhook.verifySignature(rawBody, signature)
  }

  /** Parse a verified raw webhook body into the framework's normalized event union. */
  parseWebhook(provider: string, rawBody: string): WebhookEvent[] {
    return this.use(provider).webhook.parse(rawBody)
  }
}
