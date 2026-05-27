/**
 * `securityHeadersMiddleware` — appends defensive headers to every response.
 *
 * Defaults match `spec/http.md §Security headers`. Apps override any subset
 * via `config.http.securityHeaders` — pass `null` for a key to *remove* a
 * default header (e.g., disable HSTS on a non-HTTPS dev domain).
 *
 * Implemented as a function (no per-request state, no DI) and configured at
 * registration time so the header table is built once.
 */

import type { MiddlewareFn } from '../middleware/types.ts'

export interface SecurityHeadersOptions {
  /**
   * Override or remove individual default headers. `null` removes a default;
   * a string replaces it; an absent key keeps the default.
   */
  headers?: Record<string, string | null>
}

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export function securityHeadersMiddleware(options: SecurityHeadersOptions = {}): MiddlewareFn {
  const merged: Record<string, string> = { ...DEFAULT_HEADERS }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }
  const entries = Object.entries(merged)

  return async (ctx, next) => {
    for (const [name, value] of entries) {
      ctx.response.header(name, value)
    }
    return next()
  }
}
