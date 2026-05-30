import { Router } from '@strav/http'
import { type Application, ServiceProvider } from '@strav/kernel'
import { registerApiRoutes } from '../../routes/api.ts'

/**
 * Application-level wiring: registers routes, app-owned bindings, custom
 * middleware. Runs in `register()` (not `boot()`) so the router still
 * accepts route additions — `HttpProvider.boot()` compiles the trie and
 * locks the registry.
 */
export class AppProvider extends ServiceProvider {
  override readonly name = 'app'
  override readonly dependencies = ['http']

  override register(app: Application): void {
    registerApiRoutes(app.resolve(Router))
  }
}
