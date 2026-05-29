/**
 * `GoogleSocialProvider` — `ServiceProvider` that registers the
 * Google driver factory on the `SocialManager`.
 *
 * Listed AFTER `SocialProvider` in `bootstrap/providers.ts`. The
 * factory is invoked lazily on first `social.use(name)`;
 * misconfigured credentials surface on first use.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { SocialConfigError } from '../social_error.ts'
import { SocialManager } from '../social_manager.ts'
import type { GoogleProviderConfig } from './google_config.ts'
import { GoogleSocialDriver } from './google_driver.ts'

export class GoogleSocialProvider extends ServiceProvider {
  override readonly name = 'social-google'
  override readonly dependencies = ['social']

  override register(app: Application): void {
    const manager = app.resolve(SocialManager)
    manager.extend('google', ({ instanceName, config }) => {
      const cfg = config as GoogleProviderConfig
      if (!cfg.clientId || !cfg.clientSecret) {
        throw new SocialConfigError(
          `GoogleSocialProvider: \`clientId\` and \`clientSecret\` are required for provider "${instanceName}".`,
          { context: { instanceName } },
        )
      }
      return new GoogleSocialDriver({ instanceName, config: cfg })
    })
  }
}
