/**
 * `HttpResponse` — the write-side surface of `ctx.response`.
 *
 * Two flavors of API:
 *
 * 1. **Factories** (`ok`, `created`, `json`, …) return a fresh `Response`
 *    that the controller should ultimately return from the action.
 *
 * 2. **Pending mutations** (`header`, `cookie`, `forgetCookie`) record what
 *    should be applied to whichever `Response` the action returns. The
 *    kernel calls `applyPending(response)` at the end of the request to
 *    merge them in. This lets deep middleware contribute headers/cookies
 *    without controllers having to wire them through.
 */

import type { CookieOptions, HttpResponseApi } from './types.ts'

interface PendingCookie {
  name: string
  value: string
  options: CookieOptions
  /** Forget flag — sets `Max-Age=0` regardless of `options.maxAge`. */
  forget?: boolean
}

export class HttpResponse implements HttpResponseApi {
  private pendingHeaders: Array<[string, string]> = []
  private pendingCookies: PendingCookie[] = []

  // ─── Factories ─────────────────────────────────────────────────────────────

  ok(data?: unknown, init?: ResponseInit): Response {
    if (data === undefined) return new Response(null, { status: 200, ...init })
    return this.json(data, { status: 200, ...init })
  }

  created(data?: unknown, location?: string): Response {
    const headers = new Headers()
    if (location) headers.set('Location', location)
    if (data === undefined) return new Response(null, { status: 201, headers })
    return this.json(data, { status: 201, headers })
  }

  noContent(): Response {
    return new Response(null, { status: 204 })
  }

  json(data: unknown, init: ResponseInit = {}): Response {
    // `init.headers` carries Bun's / undici's HeadersInit shape; the cast lets
    // both type universes line up on the Headers constructor.
    // biome-ignore lint/suspicious/noExplicitAny: Bun/undici HeadersInit drift
    const headers = new Headers(init.headers as any)
    headers.set('content-type', 'application/json; charset=utf-8')
    const { headers: _ignored, ...rest } = init
    return new Response(JSON.stringify(data), { ...rest, headers })
  }

  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    const headers = new Headers()
    headers.set('Location', url)
    return new Response(null, { status, headers })
  }

  stream(body: ReadableStream | AsyncIterable<unknown>, init: ResponseInit = {}): Response {
    if (body instanceof ReadableStream) return new Response(body, init)
    return new Response(asyncIterableToStream(body), init)
  }

  // ─── Pending mutations ────────────────────────────────────────────────────

  header(name: string, value: string): void {
    this.pendingHeaders.push([name, value])
  }

  cookie(name: string, value: string, options: CookieOptions = {}): void {
    this.pendingCookies.push({ name, value, options })
  }

  forgetCookie(name: string, opts: Pick<CookieOptions, 'domain' | 'path'> = {}): void {
    this.pendingCookies.push({ name, value: '', options: opts, forget: true })
  }

  /**
   * Apply queued mutations onto `response`. Returns a *new* `Response` —
   * `Response` instances aren't mutable in spec, but Bun lets us construct
   * a copy with merged headers cheaply.
   */
  applyPending(response: Response): Response {
    if (this.pendingHeaders.length === 0 && this.pendingCookies.length === 0) {
      return response
    }
    const headers = new Headers(response.headers)
    for (const [name, value] of this.pendingHeaders) {
      headers.append(name, value)
    }
    for (const cookie of this.pendingCookies) {
      headers.append('set-cookie', serializeCookie(cookie))
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

function serializeCookie(cookie: PendingCookie): string {
  const parts: string[] = [`${cookie.name}=${encodeURIComponent(cookie.value)}`]
  const opts = cookie.options
  if (cookie.forget) {
    parts.push('Max-Age=0')
    parts.push(`Expires=${new Date(0).toUTCString()}`)
  } else {
    if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
    if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`)
  }
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  if (opts.path) parts.push(`Path=${opts.path}`)
  else parts.push('Path=/')
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  if (opts.sameSite) parts.push(`SameSite=${capitalize(opts.sameSite)}`)
  return parts.join('; ')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function asyncIterableToStream(iter: AsyncIterable<unknown>): ReadableStream {
  const iterator = iter[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) {
        controller.close()
        return
      }
      if (value instanceof Uint8Array) controller.enqueue(value)
      else if (typeof value === 'string') controller.enqueue(new TextEncoder().encode(value))
      else controller.enqueue(new TextEncoder().encode(JSON.stringify(value)))
    },
    async cancel(reason) {
      if (typeof iterator.return === 'function') {
        await iterator.return(reason)
      }
    },
  })
}
