/**
 * Public types for the HTTP context — `ServerInfo`, `HttpRequest`,
 * `HttpResponse`, `CookieOptions`, and the empty-by-default `AppContextState`
 * interface that consumers extend via module augmentation.
 *
 * The classes that implement these interfaces live in sibling files:
 *   - `server_info.ts`
 *   - `http_request.ts`
 *   - `http_response.ts`
 *   - `http_context.ts`
 */

import type { Container, Logger } from '@strav/kernel'

/**
 * Strongly-typed per-request state bag. Framework-owned fields are declared
 * here; consumers add their own via module augmentation:
 *
 * ```ts
 * declare module '@strav/http' {
 *   interface AppContextState {
 *     currentUser?: User
 *     tenantId?: string
 *   }
 * }
 * ```
 *
 * The kernel always populates `requestId` — apps don't opt in. `ctx.log` is
 * pre-bound to a child logger correlated with the same value so every log
 * line inside a request carries it.
 */
export interface AppContextState {
  /** ULID per request, or the trusted upstream `X-Request-Id`. */
  requestId: string
}

export interface ServerInfo {
  /** Raw `Host` header value. */
  host: string
  /** Host without port. */
  hostname: string
  /** Registrable apex per `config.http.appDomain` — falls back to `hostname`. */
  domain: string
  /** Everything before the configured apex; `undefined` if the host doesn't end in `appDomain`. */
  subdomain?: string
  /** Explicit port, when present in the host or URL. */
  port?: number
  protocol: 'http' | 'https'
  /** Client IP — `request.ip` if Bun supplies it, otherwise `''`. */
  ip: string
  userAgent: string
}

export interface CookieOptions {
  domain?: string
  path?: string
  expires?: Date
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
}

/**
 * The handler-facing `HttpContext`. Implementations live in
 * `http_context.ts`; this interface is what middleware and controllers code
 * against.
 */
export interface HttpContext {
  server: ServerInfo
  request: HttpRequestApi
  response: HttpResponseApi
  state: AppContextState
  container: Container
  /**
   * Request-scoped child logger. Pre-bound by the kernel with `requestId`.
   * Middleware (auth, tenant, …) may reassign with a further-child to layer in
   * `userId` / `tenantId`; the property is writable for that reason.
   */
  log: Logger
}

/** The read-side surface of a request. Implemented by `HttpRequest`. */
export interface HttpRequestApi {
  readonly raw: Request
  readonly method: string
  readonly path: string
  readonly url: URL

  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string | string[]>>
  readonly headers: Headers
  readonly cookies: Readonly<Record<string, string>>

  body(): Promise<unknown>
  json<T = unknown>(): Promise<T>
  form(): Promise<FormData>
  file(name: string): Promise<File | null>
  input(): Promise<Record<string, unknown>>
  input<T = unknown>(name: string): Promise<T | undefined>

  accepts(types: readonly string[]): string | false
  wantsJson(): boolean
  isMethod(method: string): boolean
  hasHeader(name: string): boolean
}

/** The write-side surface of a response. Implemented by `HttpResponse`. */
export interface HttpResponseApi {
  ok(data?: unknown, init?: ResponseInit): Response
  created(data?: unknown, location?: string): Response
  noContent(): Response
  json(data: unknown, init?: ResponseInit): Response
  redirect(url: string, status?: 301 | 302 | 303 | 307 | 308): Response
  stream(body: ReadableStream | AsyncIterable<unknown>, init?: ResponseInit): Response

  /** Queue a header on the eventual response. */
  header(name: string, value: string): void
  /** Queue a cookie on the eventual response. */
  cookie(name: string, value: string, opts?: CookieOptions): void
  /** Queue cookie deletion on the eventual response. */
  forgetCookie(name: string, opts?: Pick<CookieOptions, 'domain' | 'path'>): void

  /**
   * Apply any pending header/cookie/forgetCookie mutations to an already-built
   * `Response` and return a new one. The kernel calls this before sending the
   * response back to Bun.
   */
  applyPending(response: Response): Response
}

/** Config consumed by `HttpContext` construction — typically from `config.http`. */
export interface HttpContextConfigSlice {
  /** Registrable apex; everything before it is `subdomain`. */
  appDomain?: string
  /** Comma-separated proxy CIDRs allowed to set `X-Forwarded-*`. */
  trustedProxies?: readonly string[]
}
