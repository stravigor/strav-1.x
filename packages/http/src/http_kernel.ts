/**
 * `HttpKernel` — turns a Bun `Request` into a `Response`.
 *
 * Per-request lifecycle:
 *   1. Match `(method, path)` against the router's trie.
 *   2. Create a request scope from the application container.
 *   3. Build `ServerInfo` / `HttpRequest` / `HttpResponse` and a request-scoped
 *      child `Logger`.
 *   4. Bind the resulting `HttpContext` into the scope.
 *   5. Compose the middleware chain (globals + route middleware) plus the
 *      final handler. Dispatch.
 *   6. Apply pending header/cookie mutations onto the returned `Response`.
 *   7. Fire-and-forget any `terminate(ctx, response)` hooks.
 *   8. Dispose the request scope.
 *
 * Two entry points:
 *   - `handle(request, opts?)` — pure request/response. Useful for tests.
 *   - `serve(opts)` — start `Bun.serve()` and wire `handle()` into it.
 *
 * The kernel never throws past its boundary: every error funnels through the
 * resolved `ExceptionHandler.renderHttp`.
 */

import {
  type Application,
  asStravError,
  type Container,
  Logger,
  NotFoundError,
} from '@strav/kernel'
import { HttpContext } from './context/http_context.ts'
import { HttpRequest } from './context/http_request.ts'
import { HttpResponse } from './context/http_response.ts'
import { buildServerInfo } from './context/server_info.ts'
import type { HttpContextConfigSlice } from './context/types.ts'
import type { ExceptionHandler } from './exception_handler.ts'
import { composeMiddleware, type FinalHandler } from './middleware/compose.ts'
import type { MiddlewareRegistry } from './middleware/registry.ts'
import type { MiddlewareDef } from './middleware/types.ts'
import type { Router } from './router/router.ts'
import type { CompiledRoute } from './router/types.ts'

/** Per-route artifact computed once at compile and reused per request. */
interface RoutePlan {
  middleware: readonly MiddlewareDef[]
  finalHandler: FinalHandler
}

export interface HttpKernelOptions {
  app: Application
  router: Router
  middlewareRegistry: MiddlewareRegistry
  exceptionHandler: ExceptionHandler
  /** Global middleware names applied to every request (in declaration order). */
  globalMiddleware?: readonly string[]
  /** Context-config slice — controls subdomain parsing + proxy trust. */
  contextConfig?: HttpContextConfigSlice
}

export interface ServeOptions {
  port?: number
  hostname?: string
  /** Override `process.env.PORT`. Falls back to 3000. */
  development?: boolean
}

export interface ServeHandle {
  port: number
  hostname: string
  url: URL
  stop(closeActiveConnections?: boolean): Promise<void>
}

export interface HandleOptions {
  /** Client IP — Bun provides via `server.requestIP(request)`. */
  ip?: string
  /** When true, honor `X-Forwarded-*` headers. */
  trustProxy?: boolean
}

export class HttpKernel {
  private readonly app: Application
  private readonly router: Router
  private readonly middlewareRegistry: MiddlewareRegistry
  private readonly exceptionHandler: ExceptionHandler
  private readonly globalMiddleware: readonly MiddlewareDef[]
  private readonly contextConfig: HttpContextConfigSlice
  private readonly plans = new Map<CompiledRoute, RoutePlan>()

  constructor(opts: HttpKernelOptions) {
    this.app = opts.app
    this.router = opts.router
    this.middlewareRegistry = opts.middlewareRegistry
    this.exceptionHandler = opts.exceptionHandler
    this.globalMiddleware = (opts.globalMiddleware ?? []).map((name) =>
      this.middlewareRegistry.resolve(name),
    )
    this.contextConfig = opts.contextConfig ?? {}
  }

  /**
   * Compile all route plans now. Optional — `handle()` lazily compiles a
   * plan on first encounter — but calling this from `boot()` surfaces
   * unknown-middleware errors at boot rather than at request time.
   */
  precompile(): void {
    for (const route of this.router.list()) {
      this.planFor(route)
    }
  }

  /** Convert one `Request` into one `Response`. */
  async handle(request: Request, options: HandleOptions = {}): Promise<Response> {
    const url = new URL(request.url)
    const match = this.router.match(request.method, url.pathname)

    // Build a request scope + context up-front so the error path can use
    // ctx.log / ctx.request / ctx.response just like the happy path.
    const scope = this.app.createScope()
    const server = buildServerInfo({
      request,
      ip: options.ip,
      appDomain: this.contextConfig.appDomain,
      trustProxy: options.trustProxy ?? false,
    })

    const params = match.kind === 'found' ? match.params : {}
    const httpRequest = new HttpRequest(request, params)
    const httpResponse = new HttpResponse()
    const log = this.requestScopedLogger(scope)

    const ctx = new HttpContext({
      server,
      request: httpRequest,
      response: httpResponse,
      container: scope,
      log,
    })
    scope.singleton(HttpContext, () => ctx)
    scope.singleton('http.context', () => ctx)

    let response: Response
    const terminating: Array<{
      handle: { terminate?: (ctx: HttpContext, res: Response) => unknown }
    }> = []
    try {
      if (match.kind === 'not-found') {
        throw new NotFoundError(`Route ${request.method} ${url.pathname} not found.`, {
          code: 'http.not-found',
          context: { method: request.method, path: url.pathname },
        })
      }
      if (match.kind === 'method-not-allowed') {
        response = new Response(
          JSON.stringify({
            error: {
              code: 'http.method-not-allowed',
              message: `Method ${request.method} not allowed.`,
            },
          }),
          {
            status: 405,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              Allow: match.allowed.join(', '),
            },
          },
        )
      } else {
        const plan = this.planFor(match.route)
        const chain = composeMiddleware(
          [...this.globalMiddleware, ...plan.middleware],
          plan.finalHandler,
          scope,
        )
        response = await chain.invoke(ctx)
        for (const inst of chain.terminatingInstances()) {
          terminating.push({ handle: inst })
        }
      }
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      try {
        await this.exceptionHandler.report(error, ctx)
      } catch (reportError) {
        ctx.log.error('http.exception_handler.report_failed', { err: reportError })
      }
      try {
        response = await this.exceptionHandler.renderHttp(error, ctx)
      } catch (renderError) {
        ctx.log.fatal('http.exception_handler.render_failed', { err: renderError })
        response = new Response(
          JSON.stringify({
            error: { code: 'server.unexpected', message: 'Internal Server Error' },
          }),
          { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
        )
      }
    }

    const finalResponse = httpResponse.applyPending(response)

    // Terminate hooks run after we have the response. Best-effort — exceptions
    // are caught and logged but never propagate back to the client.
    queueMicrotask(() => {
      for (const t of terminating) {
        const fn = t.handle.terminate
        if (!fn) continue
        try {
          const r = fn.call(t.handle, ctx, finalResponse)
          if (r && typeof (r as Promise<unknown>).catch === 'function') {
            ;(r as Promise<unknown>).catch((err) => {
              ctx.log.error('http.middleware.terminate_failed', { err })
            })
          }
        } catch (err) {
          ctx.log.error('http.middleware.terminate_failed', { err })
        }
      }
      scope.dispose()
    })

    return finalResponse
  }

  /** Start `Bun.serve()` and route requests through `handle()`. */
  serve(options: ServeOptions = {}): ServeHandle {
    const kernel = this
    const port = options.port ?? Number(process.env.PORT ?? 3000)
    const hostname = options.hostname ?? '0.0.0.0'
    // biome-ignore lint/suspicious/noExplicitAny: Bun typing varies by version
    const Bun = (globalThis as any).Bun
    if (!Bun?.serve) {
      throw new Error('HttpKernel.serve(): Bun runtime not detected.')
    }
    // biome-ignore lint/suspicious/noExplicitAny: Bun.Server type
    const server: any = Bun.serve({
      port,
      hostname,
      development: options.development,
      // biome-ignore lint/suspicious/noExplicitAny: Bun.Server type
      fetch(request: Request, srv: any): Promise<Response> {
        const ip = srv?.requestIP?.(request)?.address
        return kernel.handle(request, { ip })
      },
    })
    return {
      port: server.port,
      hostname: server.hostname,
      url: new URL(`http://${server.hostname}:${server.port}/`),
      stop: async (closeActiveConnections?: boolean) => {
        await server.stop(closeActiveConnections)
      },
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private planFor(route: CompiledRoute): RoutePlan {
    const cached = this.plans.get(route)
    if (cached) return cached

    const middleware = route.middleware.map((name) => this.middlewareRegistry.resolve(name))
    const finalHandler = this.compileFinalHandler(route)
    const plan: RoutePlan = { middleware, finalHandler }
    this.plans.set(route, plan)
    return plan
  }

  private compileFinalHandler(route: CompiledRoute): FinalHandler {
    const handler = route.handler

    // Closure form.
    if (typeof handler === 'function' && !isClassConstructor(handler)) {
      return async (ctx) => coerceResponse(await (handler as (c: typeof ctx) => unknown)(ctx))
    }

    // Tuple [Class, method] form.
    if (Array.isArray(handler) && handler.length === 2) {
      const [Class, method] = handler
      return async (ctx) => {
        const instance = ctx.container.make(Class as new () => Record<string, unknown>)
        const fn = (instance as Record<string, unknown>)[method as string]
        if (typeof fn !== 'function') {
          throw asStravError(
            new Error(
              `Route ${route.method} ${route.pattern}: ${(Class as { name?: string }).name ?? 'Controller'}.${String(method)} is not a function.`,
            ),
          )
        }
        const out = await (fn as (c: typeof ctx) => unknown).call(instance, ctx)
        return coerceResponse(out)
      }
    }

    // Single-action class form — `.handle(ctx)`.
    if (typeof handler === 'function' && isClassConstructor(handler)) {
      const Class = handler as new () => { handle(ctx: HttpContext): unknown | Promise<unknown> }
      return async (ctx) => {
        const instance = ctx.container.make(Class)
        const out = await instance.handle(ctx)
        return coerceResponse(out)
      }
    }

    throw new Error(`Route ${route.method} ${route.pattern}: unsupported handler shape.`)
  }

  private requestScopedLogger(scope: Container): Logger {
    if (!this.app.has(Logger)) {
      throw new Error(
        'HttpKernel: no Logger registered. Make sure LoggerProvider runs before HttpProvider.',
      )
    }
    const base = scope.resolve(Logger)
    // Caller middleware (e.g., request_id) layers requestId onto this. For
    // now we return the base logger; child binding is the responsibility of
    // request_log/request_id middleware once that lands.
    return base
  }
}

function isClassConstructor(value: unknown): boolean {
  return typeof value === 'function' && /^\s*class\b/.test(Function.prototype.toString.call(value))
}

/**
 * Coerce a handler's return value into a `Response`:
 *   - `Response` → returned as-is.
 *   - `null` / `undefined` → 204 No Content.
 *   - everything else → `application/json` 200.
 */
function coerceResponse(value: unknown): Response {
  if (value instanceof Response) return value
  if (value === null || value === undefined) return new Response(null, { status: 204 })
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
