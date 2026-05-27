/**
 * `RequestLog` — terminating middleware that emits one `http.request` line
 * per request, after the response has been sent.
 *
 * Captures duration via `performance.now()` in `handle()` and reads the final
 * status / size from the response in `terminate()`. The line is keyed
 * `http.request` per `spec/errors-and-logging.md §Request log`. The
 * request-scoped logger (`ctx.log`) is already correlated with `requestId` by
 * the kernel, so the line carries it implicitly.
 *
 * Implements `MiddlewareClass` so the kernel collects this instance for the
 * `terminate(ctx, response)` callback that runs *after* the response leaves
 * the kernel (best-effort — errors in `terminate()` are caught and logged
 * but never surface to the client).
 */

import type { HttpContext } from '../context/types.ts'
import type { MiddlewareClass, NextFn } from '../middleware/types.ts'

interface PerRequest {
  start: number
}

const PER_REQUEST = new WeakMap<HttpContext, PerRequest>()

export class RequestLog implements MiddlewareClass {
  async handle(ctx: HttpContext, next: NextFn): Promise<Response> {
    PER_REQUEST.set(ctx, { start: performance.now() })
    return next()
  }

  terminate(ctx: HttpContext, response: Response): void {
    const meta = PER_REQUEST.get(ctx)
    PER_REQUEST.delete(ctx)
    const durationMs = meta ? Math.round(performance.now() - meta.start) : 0

    ctx.log.info('http.request', {
      method: ctx.request.method,
      path: ctx.request.path,
      status: response.status,
      duration_ms: durationMs,
      ip: ctx.server.ip || undefined,
      user_agent: ctx.server.userAgent || undefined,
    })
  }
}
