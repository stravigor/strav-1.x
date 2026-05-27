/**
 * `HttpProvider` — wires the HTTP layer into the application container.
 *
 * Bindings (singletons):
 *   - `Router`
 *   - `MiddlewareRegistry`
 *   - `ExceptionHandler` — default subclass if the app didn't register one
 *   - `HttpKernel`
 *
 * Depends on `'logger'` so request-scoped loggers can be derived from the
 * `Logger` binding `LoggerProvider` installs.
 *
 * The provider's `boot()` compiles every route plan eagerly — middleware-name
 * typos or unknown registry entries surface during application boot instead
 * of on the first request that exercises the offending route.
 */

import { type Application, ConfigRepository, Logger, ServiceProvider } from '@strav/kernel'
import type { HttpContextConfigSlice } from './context/types.ts'
import { ExceptionHandler } from './exception_handler.ts'
import { HttpKernel } from './http_kernel.ts'
import { MiddlewareRegistry } from './middleware/registry.ts'
import { Router } from './router/router.ts'

export interface HttpConfigShape {
  /** Global middleware names; runs on every request, in order. */
  middleware?: readonly string[]
  /** Registrable apex; everything before it parsed as `ctx.server.subdomain`. */
  appDomain?: string
  /** When true, honor `X-Forwarded-*` headers. */
  trustProxy?: boolean
  /** Expose stack traces in error responses (use only outside production). */
  exposeStackTrace?: boolean
}

export class HttpProvider extends ServiceProvider {
  override readonly name = 'http'
  override readonly dependencies = ['config', 'logger']

  override register(app: Application): void {
    app.singleton(Router, () => new Router())
    app.singleton(MiddlewareRegistry, () => new MiddlewareRegistry())

    // Only fall back to the default if the app hasn't already bound its own.
    if (!app.has(ExceptionHandler)) {
      app.singleton(ExceptionHandler, (c) => {
        const config = c.resolve(ConfigRepository).get('http') as HttpConfigShape | undefined
        return new ExceptionHandler(c.resolve(Logger), {
          exposeStackTrace: config?.exposeStackTrace ?? !app.isProduction(),
        })
      })
    }

    app.singleton(HttpKernel, (c) => {
      const config = (c.resolve(ConfigRepository).get('http') as HttpConfigShape | undefined) ?? {}
      const contextConfig: HttpContextConfigSlice = {}
      if (config.appDomain !== undefined) contextConfig.appDomain = config.appDomain
      return new HttpKernel({
        app,
        router: c.resolve(Router),
        middlewareRegistry: c.resolve(MiddlewareRegistry),
        exceptionHandler: c.resolve(ExceptionHandler),
        globalMiddleware: config.middleware ?? [],
        contextConfig,
      })
    })
  }

  override async boot(app: Application): Promise<void> {
    const router = app.resolve(Router)
    router.compile()
    app.resolve(HttpKernel).precompile()
  }
}
