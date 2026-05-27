/**
 * `ExceptionHandler` — the contract every HTTP error funnels through.
 *
 * The kernel resolves it from the container per request. Apps either bind
 * their own subclass before `HttpProvider.boot()` runs, or accept the default
 * behavior (`HttpProvider` binds `new ExceptionHandler(logger, …)` when no
 * custom one is registered).
 *
 * Two responsibilities:
 *   - `report(error, ctx)` — log/forward. Default: structured log at `error`
 *     level. 4xx `StravError`s default to silent (only `renderHttp` runs) since
 *     they're user-input noise, not actionable.
 *   - `renderHttp(error, ctx)` — produce a `Response`. Default: JSON when
 *     the caller wants JSON, else minimal HTML.
 *
 * Spec mapping (`spec/errors-and-logging.md` + `spec/http.md`):
 *
 *   | Error                | Status |
 *   |----------------------|--------|
 *   | ValidationError      | 422    |
 *   | AuthError            | 401    |
 *   | AuthorizationError   | 403    |
 *   | NotFoundError        | 404    |
 *   | ConflictError        | 409    |
 *   | RateLimitError       | 429 + Retry-After |
 *   | other StravError     | carried `.status` |
 *   | unhandled Error      | 500 (sanitized in prod) |
 */

import {
  asStravError,
  isStravError,
  type Logger,
  RateLimitError,
  type StravError,
  ValidationError,
} from '@strav/kernel'
import type { HttpContext } from './context/types.ts'

export interface ExceptionHandlerOptions {
  /** Include stack/cause chain in responses + logs (only outside production). */
  exposeStackTrace?: boolean
}

export class ExceptionHandler {
  constructor(
    protected readonly logger: Logger,
    protected readonly options: ExceptionHandlerOptions = {},
  ) {}

  report(error: Error, ctx: HttpContext): void | Promise<void> {
    if (this.shouldSkipReport(error)) return
    ctx.log.error('http.unhandled', {
      err: error,
      method: ctx.request.method,
      path: ctx.request.path,
    })
    // Reference logger so the constructor param isn't flagged unused.
    void this.logger
  }

  renderHttp(error: Error, ctx: HttpContext): Response | Promise<Response> {
    const norm: StravError = isStravError(error) ? error : asStravError(error)
    const wantsJson = ctx.request.wantsJson()

    const headers: Record<string, string> = {}
    if (norm instanceof RateLimitError) {
      const retry = (norm.context as { retryAfter?: unknown } | undefined)?.retryAfter
      if (typeof retry === 'number') headers['Retry-After'] = String(retry)
    }

    if (wantsJson || !this.isHtmlPath(ctx)) {
      return new Response(JSON.stringify(this.jsonBody(norm, error)), {
        status: norm.status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      })
    }
    return new Response(this.htmlBody(norm, error), {
      status: norm.status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    })
  }

  protected shouldSkipReport(error: Error): boolean {
    if (error instanceof ValidationError) return true
    if (isStravError(error) && error.status >= 400 && error.status < 500) return true
    return false
  }

  protected isHtmlPath(_ctx: HttpContext): boolean {
    // Until `@strav/view` lands we don't render error templates — every
    // non-JSON ask gets a minimal text/html shell. Apps override
    // `renderHttp` for richer pages.
    return true
  }

  private jsonBody(norm: StravError, original: Error): Record<string, unknown> {
    const error: Record<string, unknown> = {
      code: norm.code,
      message: norm.message,
    }
    if (norm instanceof ValidationError) {
      error.errors = (norm.context as { errors?: unknown })?.errors ?? {}
    } else if (norm.context && Object.keys(norm.context).length > 0) {
      error.context = norm.context
    }
    if (this.options.exposeStackTrace && original.stack) {
      error.stack = original.stack
    }
    return { error }
  }

  private htmlBody(norm: StravError, original: Error): string {
    const status = norm.status
    const code = norm.code
    const message = escapeHtml(norm.message ?? 'Unexpected error.')
    const trace =
      this.options.exposeStackTrace && original.stack
        ? `<pre>${escapeHtml(original.stack)}</pre>`
        : ''
    return `<!doctype html><html><head><meta charset="utf-8"><title>${status} ${code}</title></head><body><h1>${status} ${code}</h1><p>${message}</p>${trace}</body></html>`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return c
    }
  })
}
