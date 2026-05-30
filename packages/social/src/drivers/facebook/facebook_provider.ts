/**
 * `FacebookSocialProvider` — `ServiceProvider` that registers
 * the Facebook driver factory on the `SocialManager`.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { SocialConfigError } from '../../social_error.ts'
import { SocialManager } from '../../social_manager.ts'
import type { FacebookProviderConfig } from './facebook_config.ts'
import { FacebookSocialDriver } from './facebook_driver.ts'

export class FacebookSocialProvider extends ServiceProvider {
  override readonly name = 'social-facebook'
  override readonly dependencies = ['social']

  override register(app: Application): void {
    const manager = app.resolve(SocialManager)
    manager.extend('facebook', ({ instanceName, config }) => {
      const cfg = config as FacebookProviderConfig
      if (!cfg.clientId || !cfg.clientSecret) {
        throw new SocialConfigError(
          `FacebookSocialProvider: \`clientId\` and \`clientSecret\` are required for provider "${instanceName}".`,
          { context: { instanceName } },
        )
      }
      return new FacebookSocialDriver({ instanceName, config: cfg })
    })
  }
}
