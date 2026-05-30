/**
 * `LineSocialProvider` — `ServiceProvider` that registers the
 * Line driver factory on the `SocialManager`.
 *
 * List AFTER `SocialProvider` in `bootstrap/providers.ts`. The
 * factory is invoked lazily on first `social.use(name)`; misconfigured
 * Line credentials surface on first use, not at boot. Apps that
 * want fail-fast call `social.use('line')` from their own `boot()`.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { SocialConfigError } from '../../social_error.ts'
import { SocialManager } from '../../social_manager.ts'
import type { LineProviderConfig } from './line_config.ts'
import { LineSocialDriver } from './line_driver.ts'

export class LineSocialProvider extends ServiceProvider {
  override readonly name = 'social-line'
  override readonly dependencies = ['social']

  override register(app: Application): void {
    const manager = app.resolve(SocialManager)
    manager.extend('line', ({ instanceName, config }) => {
      const cfg = config as LineProviderConfig
      if (!cfg.clientId || !cfg.clientSecret) {
        throw new SocialConfigError(
          `LineSocialProvider: \`clientId\` and \`clientSecret\` are required for provider "${instanceName}".`,
          { context: { instanceName } },
        )
      }
      return new LineSocialDriver({ instanceName, config: cfg })
    })
  }
}
