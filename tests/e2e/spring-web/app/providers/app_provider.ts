import { Router } from '@strav/http'
import { type Application, ServiceProvider } from '@strav/kernel'
import { registerApiRoutes } from '../../routes/api.ts'
import { registerWebRoutes } from '../../routes/web.ts'

/**
 * Application-level wiring: registers routes, app-owned bindings, custom
 * middleware. Runs in `register()` so the router still accepts route
 * additions — `HttpProvider.boot()` compiles the trie + locks the
 * registry; `ViewProvider.boot()` then layers auto-routed pages on top.
 */
export class AppProvider extends ServiceProvider {
  override readonly name = 'app'
  override readonly dependencies = ['http']

  override register(app: Application): void {
    const router = app.resolve(Router)
    registerApiRoutes(router)
    registerWebRoutes(router)
  }
}
