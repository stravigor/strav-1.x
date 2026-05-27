# @strav/http — API Reference

This page lists every public export of `@strav/http` with signature, semantics, and a minimal example.

> **Status:** Reflects what's implemented as of M2 (in progress) — Router, HttpContext (with kernel-bound `requestId`), HttpKernel (request-id correlation), middleware composition + `MiddlewareRegistry.replace()`, ExceptionHandler, HttpProvider, and the built-in middleware set (`security_headers` / `cors` / `request_log`). `FormRequest`, sessions, Pages auto-router, WS/SSE, and the opt-in middleware set (`auth` / `throttle` / `csrf` / …) land in follow-up cuts.

## `Router`

Routes registry. Holds declarations during the boot's register phase; compiles into a trie when `compile()` is called (eagerly by `HttpProvider.boot()`, or lazily on the first `match()`).

```ts
import { Router } from '@strav/http'

const router = new Router()
router.get('/users/:id', [UserController, 'show']).name('users.show')
router.match('GET', '/users/42')
// { kind: 'found', route: …, params: { id: '42' } }
```

### Verbs

| Method | HTTP |
|---|---|
| `get(pattern, handler)` | GET |
| `post(pattern, handler)` | POST |
| `put(pattern, handler)` | PUT |
| `patch(pattern, handler)` | PATCH |
| `delete(pattern, handler)` | DELETE |
| `options(pattern, handler)` | OPTIONS |
| `head(pattern, handler)` | HEAD |
| `any(pattern, handler)` | every verb (returns `Route[]`) |

Each returns a `Route` (or `Route[]` for `any`). The `handler` slot accepts three shapes:

- **Closure** — `(ctx) => Response | unknown | Promise<…>`. Non-Response values are JSON-encoded; `null`/`undefined` become 204.
- **Single-action class** — a class whose instances expose `handle(ctx)`. The kernel `make()`s a fresh instance per request and calls `.handle(ctx)`.
- **Typed tuple** — `[Controller, 'methodName']`. The method name is constrained to keys of `Controller` whose value is callable, so typos fail at compile time.

### Path syntax

| Segment | Matches | Captured into |
|---|---|---|
| `users` | literal text | — |
| `:id` | required segment | `ctx.request.params.id` |
| `:id?` | optional segment | `params.id` when present |
| `*path` | rest of the URL (must be the final segment) | `params.path` |

Precedence at any node: **static beats param beats wildcard**. Conflicting routes (same method + pattern) throw at `compile()`.

### Groups

```ts
router.group({ prefix: '/api', name: 'api.', middleware: ['auth'] }, (api) => {
  api.group({ prefix: '/v1', name: 'v1.', middleware: 'throttle' }, (v1) => {
    v1.get('/users', [UserController, 'index'])
      .name('users.index')
      .middleware('csrf')
    // → GET /api/v1/users, name "api.v1.users.index",
    //   middleware ['auth', 'throttle', 'csrf']
  })
})
```

Nested groups concatenate prefixes + names + middleware in order.

### Named routes

`route.name('users.show')` registers the name. `resolveRoute(router, name, params, opts?)` materializes a URL string:

```ts
resolveRoute(router, 'users.show', { id: 42 })
// → '/users/42'
resolveRoute(router, 'users.show', { id: 42, tab: 'profile' })
// → '/users/42?tab=profile'  (extras append as query)
resolveRoute(router, 'users.show', { id: 42 }, { abs: true, host: 'example.com' })
// → 'https://example.com/users/42'
```

Missing required params throw `ConfigError`. Optional params (`:id?`) may be omitted.

## `Route`

Returned by every verb method. Chainable:

- `.name(value)` — register as a named route.
- `.middleware(...names)` — append middleware names; multiple calls accumulate.
- `.getName()` / `.getMiddleware()` — read accessors (used by tests + introspection).

## `HttpContext`

```ts
interface HttpContext {
  server:    ServerInfo
  request:   HttpRequestApi
  response:  HttpResponseApi
  state:     AppContextState   // empty by default — extend via module augmentation
  container: Container         // request scope
  log:       Logger            // request-scoped logger
}
```

Typed state via module augmentation:

```ts
declare module '@strav/http' {
  interface AppContextState {
    requestId: string
    currentUser?: User
  }
}

// In a middleware:
ctx.state.requestId = crypto.randomUUID()
```

A typo on a key fails to compile.

## `ServerInfo`

```ts
interface ServerInfo {
  host: string         // raw Host header value
  hostname: string     // host without port
  domain: string       // configured appDomain, or hostname when not configured
  subdomain?: string   // everything before .appDomain (or undefined)
  port?: number
  protocol: 'http' | 'https'
  ip: string           // Bun's server.requestIP(...) or '' if absent
  userAgent: string
}
```

`appDomain` comes from `config.http.appDomain`. With `appDomain = 'example.com'` and host `acme.api.example.com`, you get `subdomain = 'acme.api'`, `domain = 'example.com'`. Hosts that don't end in `.appDomain` have `subdomain = undefined` and `domain = hostname`.

`X-Forwarded-*` headers are honored only when `config.http.trustProxy` is `true` (or the kernel was called with `{ trustProxy: true }` for tests).

## `HttpRequest`

```ts
interface HttpRequestApi {
  readonly raw: Request              // the underlying Bun Request — escape hatch
  readonly method: string
  readonly path: string              // url.pathname
  readonly url: URL

  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string | string[]>>
  readonly headers: Headers
  readonly cookies: Readonly<Record<string, string>>

  body(): Promise<unknown>                          // parsed once, cached
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
```

`body()` picks the parser by `content-type` — JSON, form, text, or `ArrayBuffer`. Subsequent calls to `body()` / `json()` / `input()` return the cached value; `Request.body` is read at most once.

Cookies are parsed from the `Cookie` header on construction. The cookies object is read-only — write via `ctx.response.cookie(...)`.

## `HttpResponse`

```ts
interface HttpResponseApi {
  ok(data?, init?): Response
  created(data?, location?): Response
  noContent(): Response
  json(data, init?): Response
  redirect(url, status?: 301|302|303|307|308): Response
  stream(body: ReadableStream | AsyncIterable, init?): Response

  header(name, value): void                              // pending
  cookie(name, value, opts?): void                       // pending
  forgetCookie(name, opts?): void                        // pending
  applyPending(response): Response                       // called by the kernel
}
```

### Factories vs pending mutations

The factories return a fresh `Response` the controller should return from its action. `header(...)`, `cookie(...)`, `forgetCookie(...)` queue mutations onto the request scope — the kernel calls `applyPending(response)` after the chain returns, merging the queue onto the final Response. This means deep middleware can contribute headers/cookies without controllers wiring them through.

```ts
async store(ctx: HttpContext) {
  const user = await this.users.create(ctx.request.input())
  ctx.response.cookie('last_created', user.id, { httpOnly: true })
  return ctx.response.created(user, route('users.show', { id: user.id }))
}
```

### Cookie options

```ts
interface CookieOptions {
  domain?: string
  path?: string         // defaults to '/'
  expires?: Date
  maxAge?: number       // seconds
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
}
```

## `HttpKernel`

```ts
class HttpKernel {
  constructor(opts: HttpKernelOptions)
  precompile(): void
  handle(request: Request, opts?: HandleOptions): Promise<Response>
  serve(opts?: ServeOptions): ServeHandle
}
```

`handle(request)` is the pure entry — turns one `Request` into one `Response` without any I/O outside of body parsing. Use it in tests:

```ts
const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/health'))
expect(res.status).toBe(200)
```

`serve(opts)` starts `Bun.serve()` and routes incoming requests through `handle()`. Returns `{ port, hostname, url, stop() }`.

`precompile()` walks every registered route and builds its plan (resolves middleware names, picks the handler shape). `HttpProvider.boot()` calls this automatically so middleware-name typos fail at boot.

Errors at any layer funnel through the resolved `ExceptionHandler`. The kernel never throws past its boundary.

### Request-id correlation

Built into `handle()` — not a middleware:

1. Pull `X-Request-Id` off the request. If it parses as a ULID, use it; otherwise mint a fresh one via `ulid()`.
2. Write `ctx.state.requestId`, queue `X-Request-Id` on the response, bind `ctx.log = base.child({ requestId })`.

ULID-only validation prevents log-injection / cardinality attacks via the upstream header. Apps that need a different scheme subclass `HttpKernel` and override `resolveRequestId(request): string`.

### 404 / 405 still run middleware

Unmatched and method-mismatched paths still flow through the global middleware chain (with a final handler that throws `NotFoundError` or returns the 405 Response). This lets `cors` answer browser preflights for any URL and lets `request_log` capture not-found access patterns.

## `ExceptionHandler`

Concrete class with default implementations of `report` and `renderHttp`. Apps subclass and bind their own before `HttpProvider.boot()`; if none is bound, the provider falls back to the default.

```ts
class Handler extends ExceptionHandler {
  override report(error, ctx) {
    super.report(error, ctx)
    sentry.captureException(error, { contexts: { request: { path: ctx.request.path } } })
  }

  override renderHttp(error, ctx) {
    if (this.expectsHtml(ctx)) return ctx.response.view('errors/500', { error })
    return super.renderHttp(error, ctx)
  }
}

app.singleton(ExceptionHandler, (c) => new Handler(c.resolve(Logger)))
```

Default behavior:

| Error | Status | Body |
|---|---|---|
| `ValidationError` | 422 | `{ error: { code, message, errors } }` |
| `AuthError` | 401 | `{ error: { code, message } }` |
| `AuthorizationError` | 403 | `{ error: { code, message } }` |
| `NotFoundError` | 404 | `{ error: { code, message, context? } }` |
| `ConflictError` | 409 | `{ error: { code, message, context? } }` |
| `RateLimitError` | 429 + `Retry-After` (when `context.retryAfter` is present) | `{ error: { code, message, context? } }` |
| Any `StravError` | carried `.status` | `{ error: { code, message, context? } }` |
| Unhandled `Error` | 500 | `{ error: { code: 'server.unexpected', message } }` |

When `wantsJson()` is false (e.g., browser request without `Accept: application/json`), a minimal `text/html` shell is rendered. `@strav/view`, once it lands, will let `ExceptionHandler` look up `resources/views/errors/<status>.strav`.

4xx `StravError`s are not reported by default (only `renderHttp` runs) — those are user input noise, not actionable.

`exposeStackTrace: true` (default outside production) includes the stack on JSON + HTML responses.

## Middleware

### `MiddlewareFn` / `MiddlewareClass`

```ts
type MiddlewareFn = (ctx, next) => Response | Promise<Response>

interface MiddlewareClass {
  handle(ctx, next): Response | Promise<Response>
  terminate?(ctx, response): void | Promise<void>
}

type MiddlewareDef = MiddlewareFn | Constructor<MiddlewareClass>
```

Class middleware is instantiated per chain invocation via `scope.make(Class)` — `@inject()` dependencies resolve from the request scope.

### `MiddlewareRegistry`

```ts
const reg = app.resolve(MiddlewareRegistry)
reg.register('auth', AuthMiddleware)
reg.register('throttle', (limit, window) => makeThrottle(limit, window), { factory: true })

reg.has('throttle:60,1m')          // → true
reg.resolve('throttle:60,1m')      // → MiddlewareDef
```

Plain registrations look up by `name`; factory registrations split `name:args` and pass each comma-separated arg to the factory.

Unknown names + invalid arg shapes throw `ConfigError`.

`register` throws on duplicates. `replace(name, def)` is the override path — used by apps that want to swap a framework built-in:

```ts
reg.replace('cors', myCustomCors)
```

### `composeMiddleware(defs, finalHandler, scope)`

Builds a runnable onion. The result has `invoke(ctx)` and `terminatingInstances()`. Class middleware that exposes a `terminate(ctx, response)` method gets collected — `HttpKernel` fires those after the response is sent (best-effort, errors are logged).

Order: middleware runs in declaration order on the way in, reverse on the way out. A middleware that returns a Response without calling `next()` short-circuits the rest.

## `HttpProvider`

`name = 'http'`, `dependencies = ['config', 'logger']`. Binds:

- `Router` (singleton)
- `MiddlewareRegistry` (singleton)
- `ExceptionHandler` (singleton — default if not already bound)
- `HttpKernel` (singleton)

`boot()` calls `Router.compile()` + `HttpKernel.precompile()`. Routes should be registered during the `register()` phase of a downstream provider (depending on `'http'`) so they're in place before this runs.

`register()` also installs the three framework built-ins on the registry under the canonical names from `BUILTIN_NAMES`. Apps override individual built-ins via `MiddlewareRegistry.replace(name, def)` from a downstream provider's `register()`.

### Config slice (`config.http`)

| Key | Effect |
|---|---|
| `middleware` | Global middleware names; applied to every request |
| `appDomain` | Registrable apex; everything before it is parsed as `ctx.server.subdomain` |
| `trustProxy` | Honor `X-Forwarded-Host` / `X-Forwarded-Proto` (per-request — `kernel.handle(req, { trustProxy: true })` works the same) |
| `exposeStackTrace` | Default `ExceptionHandler` includes stack on responses; defaults to `!app.isProduction()` |
| `cors` | Options for the built-in `cors` middleware (see below) |
| `securityHeaders` | Options for the built-in `security_headers` middleware (see below) |

## Built-in middleware

`HttpProvider` auto-registers three middleware under canonical names — use them by string in `config.http.middleware` or per-route `.middleware()`. See `guides/built-ins.md` for the full recipe.

### `BUILTIN_NAMES`

```ts
import { BUILTIN_NAMES } from '@strav/http'
// → { cors: 'cors', requestLog: 'request_log', securityHeaders: 'security_headers' }
```

### `securityHeadersMiddleware(options?)`

Function middleware. Appends defensive headers via `ctx.response.header(...)`. Defaults match `spec/http.md`:

```
Content-Security-Policy:        default-src 'self'
X-Frame-Options:                DENY
X-Content-Type-Options:         nosniff
Referrer-Policy:                strict-origin-when-cross-origin
Strict-Transport-Security:      max-age=63072000
Cross-Origin-Opener-Policy:     same-origin
Cross-Origin-Resource-Policy:   same-origin
```

`options.headers` overrides per key — string replaces, `null` removes.

### `corsMiddleware(options?)`

Function middleware. Cross-origin handling.

```ts
interface CorsOptions {
  origin?: '*' | string | readonly string[] | ((origin: string) => boolean)  // default '*'
  methods?: readonly string[]
  headers?: readonly string[]
  exposedHeaders?: readonly string[]
  credentials?: boolean
  maxAge?: number
}
```

Preflight (`OPTIONS` with `Access-Control-Request-Method`) short-circuits with a 204 — works for any URL because the kernel runs global middleware on the 404/405 path as well. `origin: '*'` implicitly disables credentials (per the CORS spec).

### `RequestLog`

Class middleware. Captures `performance.now()` in `handle()` and emits one `http.request` line in `terminate()`. Fields: `method`, `path`, `status`, `duration_ms`, `ip`, `user_agent`, plus the `requestId` already carried by `ctx.log`. Runs for every status — 500s, 404s, 405s, etc. — but is skipped on CORS preflights when `cors` runs earlier in the chain.
