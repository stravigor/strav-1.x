/**
 * `ViewProvider` reads `config('view')`, constructs a `ViewEngine`,
 * and binds:
 *   - `ViewEngine` (singleton) — the public surface.
 *   - `'view'` (string alias) — same instance, for `@inject('view')`.
 *
 * Depends on `'config'`. When `@strav/http` is also registered, the
 * `boot()` phase auto-registers pages routes onto the bound `Router`
 * (unless `config.view.pages.autoRoute === false`).
 *
 * Config is OPTIONAL — apps with no `config.view` get sensible
 * defaults (`directory: 'resources/views'`, `cache: true`). This is
 * intentionally laxer than `MailProvider`'s "config required" stance:
 * apps with `.strav` files under the conventional location can use
 * `ViewProvider` with zero configuration.
 */

import { resolve } from 'node:path'
import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { registerPages } from './pages.ts'
import { type ViewConfig, ViewEngine } from './view_engine.ts'

/** String key for the Router — avoids a hard import of @strav/http at module load. */
const ROUTER_KEY = 'router'

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

  override async boot(app: Application): Promise<void> {
    const raw = app.resolve(ConfigRepository).get('view')
    const config = raw === undefined || raw === null ? {} : (raw as ViewConfig)

    // Pages auto-router: only runs when a Router is in the container
    // (i.e., @strav/http is registered) and pages.autoRoute !== false.
    if (config.pages?.autoRoute === false) return
    if (!app.has(ROUTER_KEY)) return

    const engine = app.resolve(ViewEngine)
    // Dynamic import so @strav/http remains an optional runtime dep.
    // ViewProvider works fine without it (rendering still works; just
    // no pages routes get registered).
    const { Router } = await import('@strav/http')
    if (!app.has(Router)) return

    const router = app.resolve(Router)

    const pagesDir = config.pages?.pagesDir ? resolve(config.pages.pagesDir) : undefined

    await registerPages(engine, router, {
      pagesDir,
      middleware: config.pages?.middleware ?? [],
    })
  }
}
