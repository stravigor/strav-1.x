/**
 * `LineInstantProvider` — `ServiceProvider` that registers the
 * LINE driver factory on the `InstantManager`.
 *
 * Apps list this AFTER `InstantProvider` in
 * `bootstrap/providers.ts`. Driver instances construct lazily on
 * first `instant.use(name)` call.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { InstantConfigError } from '../errors.ts'
import { InstantManager } from '../instant_manager.ts'
import type { LineProviderConfig } from './line_config.ts'
import { LineDriver } from './line_driver.ts'

export class LineInstantProvider extends ServiceProvider {
  override readonly name = 'instant-line'
  override readonly dependencies = ['instant']

  override register(app: Application): void {
    const manager = app.resolve(InstantManager)
    manager.extend('line', ({ instanceName, config }) => {
      const cfg = config as LineProviderConfig
      if (!cfg.channelAccessToken || !cfg.channelSecret) {
        throw new InstantConfigError(
          `LineInstantProvider: \`channelAccessToken\` and \`channelSecret\` are required for provider "${instanceName}".`,
          { context: { instanceName } },
        )
      }
      return new LineDriver({ instanceName, config: cfg })
    })
  }
}
