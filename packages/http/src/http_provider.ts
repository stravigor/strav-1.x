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
import {
  BUILTIN_NAMES,
  type CorsOptions,
  corsMiddleware,
  RequestLog,
  type SecurityHeadersOptions,
  securityHeadersMiddleware,
} from './built_in/index.ts'
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
  /** Configuration for the built-in `cors` middleware. */
  cors?: CorsOptions
  /** Configuration for the built-in `security_headers` middleware. */
  securityHeaders?: SecurityHeadersOptions
}

export class HttpProvider extends ServiceProvider {
  override readonly name = 'http'
  override readonly dependencies = ['config', 'logger']

  override register(app: Application): void {
    app.singleton(Router, () => new Router())
    app.singleton(MiddlewareRegistry, () => {
      const registry = new MiddlewareRegistry()
      this.registerBuiltins(app, registry)
      return registry
    })

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

  /**
   * Register the framework built-in middleware. Each registers under a
   * canonical name (see `BUILTIN_NAMES`). Apps override a built-in by
   * calling `MiddlewareRegistry.replace(name, def)` from a downstream
   * provider's `register()` — see `docs/http/guides/built-ins.md`.
   */
  private registerBuiltins(app: Application, registry: MiddlewareRegistry): void {
    const config = (app.resolve(ConfigRepository).get('http') as HttpConfigShape | undefined) ?? {}

    if (!registry.has(BUILTIN_NAMES.securityHeaders)) {
      registry.register(
        BUILTIN_NAMES.securityHeaders,
        securityHeadersMiddleware(config.securityHeaders ?? {}),
      )
    }
    if (!registry.has(BUILTIN_NAMES.cors)) {
      registry.register(BUILTIN_NAMES.cors, corsMiddleware(config.cors ?? {}))
    }
    if (!registry.has(BUILTIN_NAMES.requestLog)) {
      registry.register(BUILTIN_NAMES.requestLog, RequestLog)
    }
  }
}
