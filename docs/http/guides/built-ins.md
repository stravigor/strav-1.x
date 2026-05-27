# Built-in middleware — what ships, how to configure, how to override

`HttpProvider` auto-registers three built-ins on the `MiddlewareRegistry`. They're available by canonical name; apps add them to `config.http.middleware` to make them global, or attach them per-route via `.middleware('name')`.

> **What's NOT here yet.** `i18n`, `error_handler` (the kernel already funnels every throw through `ExceptionHandler` — no separate middleware needed), and the opt-in set (`auth`, `throttle`, `csrf`, `idempotency`, `signed`, `cache`, `policy`) land in later M2 cuts.

## The canonical names

```ts
import { BUILTIN_NAMES } from '@strav/http'
// → { cors: 'cors', requestLog: 'request_log', securityHeaders: 'security_headers' }
```

Use them verbatim in config:

```ts
// config/http.ts
export default {
  middleware: ['security_headers', 'cors', 'request_log'],
  cors: { origin: ['https://app.example.com'], credentials: true },
  securityHeaders: { headers: { 'X-Frame-Options': 'SAMEORIGIN' } },
}
```

## `security_headers`

Function middleware. Appends defensive headers via the response's pending-mutation queue (no per-request state, no DI).

**Defaults** (from `spec/http.md`):

```
Content-Security-Policy:        default-src 'self'
X-Frame-Options:                DENY
X-Content-Type-Options:         nosniff
Referrer-Policy:                strict-origin-when-cross-origin
Strict-Transport-Security:      max-age=63072000
Cross-Origin-Opener-Policy:     same-origin
Cross-Origin-Resource-Policy:   same-origin
```

**Override** via `config.http.securityHeaders.headers`. A string replaces; `null` removes:

```ts
securityHeaders: {
  headers: {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:",
    'Strict-Transport-Security': null,   // dev: disable HSTS on http://localhost
  },
}
```

Other defaults remain in place — overrides are additive.

## `cors`

Function middleware. Cross-origin handling for browser requests.

```ts
cors: {
  origin: ['https://app.example.com'],   // '*' | string | string[] | (origin) => boolean
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],  // default
  headers: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 3600,
}
```

### Preflight

When the kernel sees `OPTIONS` + `Access-Control-Request-Method`, CORS short-circuits with a 204 response carrying the negotiated headers. This works **even when no route matches the path** — the kernel runs global middleware on the 404/405 path so CORS can answer preflights for any URL the browser asks about. The route handler never runs for preflights.

### Origins

- `'*'` — open. Browsers ignore credentials when the server replies `Access-Control-Allow-Origin: *`, so this mode implicitly disables credentials.
- `string | string[]` — exact-match allowlist. The matched origin is echoed in the response (per the CORS spec, credentials require an exact echo, not `*`).
- `(origin) => boolean` — programmatic. Useful for "any tenant subdomain", regex checks, etc.

### Position matters

CORS should be **early** in the global chain so preflight short-circuits skip downstream middleware. With `middleware: ['cors', 'request_log']`, the preflight returns from CORS without ever calling `request_log.handle` — so preflights aren't in the access log. Reversed, every preflight produces a log line.

## `request_log`

Class middleware (implements `MiddlewareClass`). Captures `performance.now()` in `handle()` and emits one structured log line in `terminate()`, after the response has been sent.

```json
{
  "level": 30,
  "msg":   "http.request",
  "method": "GET",
  "path":   "/api/users/42",
  "status": 200,
  "duration_ms": 23,
  "ip": "203.0.113.4",
  "user_agent": "...",
  "requestId": "01J3K…"
}
```

`requestId` is carried by `ctx.log` automatically (the kernel pre-binds `ctx.log = base.child({ requestId })`). Other fields are pulled off `ctx.request` / `ctx.server` / the final `response`.

The log fires regardless of status — 500s, 404s, 405s all produce a line. CORS preflights skip it as long as `cors` runs first.

## The kernel-level request-id

Not a middleware — baked into `HttpKernel.handle()`:

1. If the incoming request has `X-Request-Id` and the value parses as a ULID, use it.
2. Otherwise mint a fresh ULID.
3. Write it to `ctx.state.requestId` and queue `X-Request-Id` on the response.
4. Bind `ctx.log = base.child({ requestId })`.

ULID-only validation is deliberate — accepting arbitrary upstream IDs is a classic log-injection / log-cardinality footgun. Apps that need a different scheme subclass `HttpKernel.resolveRequestId(request)`.

## Overriding a built-in

`MiddlewareRegistry.register` throws on duplicates. Use `replace`:

```ts
class RoutesProvider extends ServiceProvider {
  override readonly name = 'routes'
  override readonly dependencies = ['http']

  override register(app: Application): void {
    const reg = app.resolve(MiddlewareRegistry)
    reg.replace('cors', myCustomCors)
    // ... routes
  }
}
```

Topologically `RoutesProvider.register` runs after `HttpProvider.register` (which installed the built-ins) but before `HttpProvider.boot` (which compiles route plans). The override lands in time.

## Ordering recommendation

For a typical HTML+JSON app:

```ts
middleware: ['security_headers', 'cors', 'request_log']
```

Why this order:

- `security_headers` first → every response (including error pages from `ExceptionHandler`) carries the defenders.
- `cors` second → preflight short-circuits skip `request_log` (cleaner access log).
- `request_log` last → it sees the actual final status from the rest of the chain plus whatever wrapping happens upstream.

Route-level middleware (`auth`, `throttle`, etc.) layers inside the globals — handler is at the center of the onion.
