/**
 * Binds `ConfigRepository` under the `'config'` key and arranges the
 * freeze-on-`app:booted` contract.
 *
 * Typical usage from `bootstrap/providers.ts`:
 *
 * ```ts
 * import appConfig from '../config/app.ts'
 * import dbConfig  from '../config/database.ts'
 *
 * export default [
 *   new ConfigProvider({ app: appConfig, database: dbConfig }),
 *   // ... other providers
 * ]
 * ```
 *
 * `ConfigProvider` is the first provider to register (no deps), so other
 * providers can `c.resolve<ConfigRepository>('config')` in their own
 * `register()` and `boot()` calls.
 */

import { type ConfigData, ConfigRepository } from '../config/configuration.ts'
import { type Application, ServiceProvider } from '../core/index.ts'

export class ConfigProvider extends ServiceProvider {
  override readonly name = 'config'
  override readonly dependencies = []

  constructor(private readonly data: ConfigData = {}) {
    super()
  }

  override register(app: Application): void {
    const repository = new ConfigRepository(this.data)
    app.singleton('config', () => repository)
    app.singleton(ConfigRepository, () => repository)
  }

  override boot(app: Application): void {
    // ConfigProvider boots first (no deps), so its `once('app:booted', ...)`
    // is the first listener for that event — it runs before any user listener
    // can mutate config.
    app.events.once('app:booted', () => {
      app.resolve(ConfigRepository).freeze()
    })
  }
}
