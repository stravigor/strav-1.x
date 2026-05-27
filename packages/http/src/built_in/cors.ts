/**
 * `corsMiddleware` — Cross-Origin Resource Sharing.
 *
 * Per-route registration; configured once from `config.http.cors`. Three
 * tiers of `origin` matching cover the realistic cases:
 *   - `'*'` — open (no credentials allowed by spec).
 *   - `string | string[]` — exact allowlist.
 *   - `(origin) => boolean` — fully programmatic.
 *
 * Preflight (`OPTIONS` with `Access-Control-Request-Method`) returns 204
 * immediately, before the route's handler runs — the spec's "router does not
 * need an OPTIONS route" guarantee. Non-preflight responses just have the
 * CORS headers appended via the pending-mutation queue, and the rest of the
 * chain runs normally.
 */

import type { MiddlewareFn } from '../middleware/types.ts'

export interface CorsOptions {
  /**
   * Allowed origin(s).
   *   - `'*'` opens to all (credentials disabled, per the CORS spec).
   *   - `string` or `string[]` is an exact match list.
   *   - A function returns `true` to allow the requesting origin.
   *
   * Defaults to `'*'` if omitted.
   */
  origin?: '*' | string | readonly string[] | ((origin: string) => boolean)
  methods?: readonly string[]
  headers?: readonly string[]
  exposedHeaders?: readonly string[]
  credentials?: boolean
  /** Preflight cache in seconds. */
  maxAge?: number
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

export function corsMiddleware(options: CorsOptions = {}): MiddlewareFn {
  const matcher = compileOriginMatcher(options.origin ?? '*')
  const methods = options.methods ?? DEFAULT_METHODS
  const allowedHeaders = options.headers
  const exposedHeaders = options.exposedHeaders
  const credentials = options.credentials === true
  const maxAge = options.maxAge

  return async (ctx, next) => {
    const origin = ctx.request.headers.get('origin')
    if (!origin) return next() // not a cross-origin call

    const decision = matcher(origin)
    if (!decision.allow) return next() // disallowed — pass through unchanged

    // Preflight: short-circuit before the route handler.
    const isPreflight =
      ctx.request.isMethod('OPTIONS') && ctx.request.hasHeader('access-control-request-method')

    if (isPreflight) {
      const headers = new Headers()
      headers.set('Access-Control-Allow-Origin', decision.echo)
      headers.set('Access-Control-Allow-Methods', methods.join(', '))
      if (allowedHeaders) {
        headers.set('Access-Control-Allow-Headers', allowedHeaders.join(', '))
      } else {
        const requested = ctx.request.headers.get('access-control-request-headers')
        if (requested) headers.set('Access-Control-Allow-Headers', requested)
      }
      if (credentials) headers.set('Access-Control-Allow-Credentials', 'true')
      if (maxAge !== undefined) headers.set('Access-Control-Max-Age', String(maxAge))
      headers.append('Vary', 'Origin')
      return new Response(null, { status: 204, headers })
    }

    // Regular response: queue CORS headers via pending mutations.
    ctx.response.header('Access-Control-Allow-Origin', decision.echo)
    ctx.response.header('Vary', 'Origin')
    if (credentials) ctx.response.header('Access-Control-Allow-Credentials', 'true')
    if (exposedHeaders && exposedHeaders.length > 0) {
      ctx.response.header('Access-Control-Expose-Headers', exposedHeaders.join(', '))
    }
    return next()
  }
}

interface OriginDecision {
  allow: boolean
  /** What to echo back in `Access-Control-Allow-Origin`. */
  echo: string
}

function compileOriginMatcher(
  origin: '*' | string | readonly string[] | ((origin: string) => boolean),
): (origin: string) => OriginDecision {
  if (typeof origin === 'function') {
    return (o) => (origin(o) ? { allow: true, echo: o } : { allow: false, echo: '' })
  }
  if (origin === '*') {
    // Per the CORS spec, `*` is incompatible with credentials. Apps that
    // want credentials must list explicit origins.
    return () => ({ allow: true, echo: '*' })
  }
  const list = typeof origin === 'string' ? [origin] : [...origin]
  const set = new Set(list)
  return (o) => (set.has(o) ? { allow: true, echo: o } : { allow: false, echo: '' })
}
