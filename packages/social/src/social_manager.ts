/**
 * `SocialManager` — the facade apps use for social-login flows.
 *
 * Three concept clusters:
 *
 *   - **Drivers.** Apps declare providers in
 *     `config.social.providers`. The manager constructs each
 *     driver lazily on first `use(name)` call + memoizes.
 *     Custom drivers register via `manager.extend(name, factory)`.
 *
 *   - **Resource accessors** (`authorize`, `exchange`, `profile`,
 *     `refresh`, `revoke`) — route to the default driver. Apps
 *     that route by region call `social.use('asia').authorize(...)`.
 *
 *   - **Capabilities.** `driver.capabilities` exposes the
 *     feature set — apps that build provider-aware UI (e.g.
 *     "only show refresh button if the driver supports it")
 *     read from there.
 */

import type {
  AuthorizeInput,
  AuthorizeResult,
  ExchangeInput,
  RefreshInput,
  SocialDriver,
  SocialDriverFactory,
} from './social_driver.ts'
import type { OAuthTokens, SocialProfile } from './dto/index.ts'
import {
  SocialConfigError,
  UnknownProviderError,
} from './social_error.ts'
import type { ProviderConfig, SocialConfig } from './types.ts'

export interface SocialManagerOptions {
  config: SocialConfig
}

export class SocialManager {
  readonly config: SocialConfig
  private readonly drivers = new Map<string, SocialDriver>()
  private readonly extensions = new Map<string, SocialDriverFactory>()

  constructor(options: SocialManagerOptions) {
    const { config } = options
    if (!config.providers[config.default]) {
      throw new SocialConfigError(
        `SocialManager: default provider "${config.default}" is not configured.`,
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

  use(name?: string): SocialDriver {
    const key = name ?? this.config.default
    const cached = this.drivers.get(key)
    if (cached) return cached

    const cfg = this.config.providers[key]
    if (!cfg) {
      throw new UnknownProviderError(key, Object.keys(this.config.providers))
    }
    const ext = this.extensions.get(cfg.driver)
    if (!ext) {
      throw new SocialConfigError(
        `SocialManager: unknown driver "${cfg.driver}" for provider "${key}". Register it via \`manager.extend("${cfg.driver}", factory)\` or install the matching adapter package.`,
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

  /** Register a driver factory. Adapter packages call this from their ServiceProvider. */
  extend(driverName: string, factory: SocialDriverFactory): void {
    this.extensions.set(driverName, factory)
  }

  /** Hand-wire a driver instance (tests / one-offs). */
  useDriver(instanceName: string, driver: SocialDriver): void {
    this.drivers.set(instanceName, driver)
  }

  // ─── Resource accessors (route to the default driver) ────────────────

  authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    return this.use().authorize(input)
  }

  exchange(input: ExchangeInput): Promise<OAuthTokens> {
    return this.use().exchange(input)
  }

  profile(accessToken: string): Promise<SocialProfile> {
    return this.use().profile(accessToken)
  }

  refresh(input: RefreshInput): Promise<OAuthTokens> {
    return this.use().refresh(input)
  }

  revoke(token: string): Promise<void> {
    return this.use().revoke(token)
  }
}
