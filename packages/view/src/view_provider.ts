/**
 * `ViewProvider` reads `config('view')`, constructs a `ViewEngine`,
 * and binds:
 *   - `ViewEngine` (singleton) — the public surface.
 *   - `'view'` (string alias) — same instance, for `@inject('view')`.
 *
 * Depends on `'config'`. The engine has no per-request state, so a
 * single instance serves the whole process.
 *
 * Config is OPTIONAL — apps with no `config.view` get sensible
 * defaults (`directory: 'resources/views'`, `cache: true`). This is
 * intentionally laxer than `MailProvider`'s "config required" stance:
 * apps with `.strav` files under the conventional location can use
 * `ViewProvider` with zero configuration.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { type ViewConfig, ViewEngine } from './view_engine.ts'

export class ViewProvider extends ServiceProvider {
  override readonly name = 'view'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(ViewEngine, (c) => {
      const raw = c.resolve(ConfigRepository).get('view')
      const config = raw === undefined || raw === null ? {} : (raw as ViewConfig)
      return new ViewEngine({ config })
    })
    app.singleton('view', (c) => c.resolve(ViewEngine))
  }
}
