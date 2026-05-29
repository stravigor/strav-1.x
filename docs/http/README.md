# @strav/http

Routing, request/response handling, and the HTTP kernel for Strav 1.0.

> **Status: 1.0.0-alpha.6 — M2 shipped.**
> Shipping: **Router** (trie, params, optional params, wildcards, groups, named routes, tuple-arity-3 FormRequest sugar), **HttpContext** (server / request / response namespaces + typed `state` with kernel-bound `requestId`), **HttpRequest** (cached body parsing, query, cookies, content negotiation), **HttpResponse** (factories + pending header/cookie mutations), **middleware composition** (onion, short-circuit, terminating), **MiddlewareRegistry** (name → def, parameterized `name:args` factories, `replace` for built-in override), **HttpKernel** (`handle()` / `serve()`; baked-in request-id + correlated child logger), **ExceptionHandler** (default JSON + HTML, `StravError` mapping), **HttpProvider** (container wiring + boot-time precompile + built-in registration), **built-in middleware** (`security_headers`, `cors`, `request_log`), **FormRequest** (Zod-backed `rule.*` API, lifecycle, registered custom rules, spec-shaped validation error responses).
> Deferred for now: subdomain matching, sessions, Pages auto-router, WS/SSE, opt-in middleware (`auth`, `throttle`, `csrf`, etc.), type-detected `(req, ctx)` action signature.

## Install

```bash
bun add @strav/http
```

`@strav/kernel` is a peer dep — it's already in the workspace.

## Minimal app

```ts
// bin/strav.ts
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'
import { HttpKernel, HttpProvider, Router } from '@strav/http'
import loggerConfig from '../config/logger.ts'

const app = new Application().useProviders([
  new ConfigProvider({ logger: loggerConfig }),
  new LoggerProvider(),
  new HttpProvider(),
])

// Register your routes via a small provider so they land before HttpProvider.boot().
class Routes extends ServiceProvider {
  override readonly name = 'routes'
  override readonly dependencies = ['http']
  override register(app: Application): void {
    const router = app.resolve(Router)
    router.get('/health', (ctx) => ctx.response.ok({ ok: true }))
    router.get('/users/:id', [UserController, 'show'])
  }
}
app.use(new Routes())

await app.start()
const server = app.resolve(HttpKernel).serve({ port: 3000 })
console.log(`listening on ${server.url}`)
```

## What's here

| Symbol | Purpose |
|---|---|
| `Router` | Routes registry; trie-backed match; groups; named routes |
| `Route` | Chainable builder returned by `router.<method>(...)`; `.name()`, `.middleware()` |
| `resolveRoute(router, name, params, opts?)` | Named-route → URL string |
| `HttpKernel` | Per-request orchestrator; `handle(request)` for tests, `serve()` to start Bun |
| `HttpContext` | `server` / `request` / `response` / `state` / `container` / `log` |
| `HttpRequest` | Cached body parsing; query; cookies; `accepts()` / `wantsJson()` |
| `HttpResponse` | `ok` / `created` / `noContent` / `json` / `redirect` / `stream` + pending header/cookie mutations |
| `MiddlewareRegistry` | Name → middleware-def map; supports `name:args` factories |
| `composeMiddleware` | Function-level onion composer; collects terminating instances |
| `ExceptionHandler` | Default JSON/HTML renderer + `StravError` → HTTP-status mapping; subclass to customize |
| `HttpProvider` | Provider that wires `Router`, `MiddlewareRegistry`, `ExceptionHandler`, `HttpKernel`, and auto-registers built-in middleware |
| `securityHeadersMiddleware` / `corsMiddleware` / `RequestLog` | Built-in middleware shipped under canonical names (`security_headers`, `cors`, `request_log`) |
| `BUILTIN_NAMES` | The string-key constants for `config.http.middleware` |
| `FormRequest` | Typed-payload primitive — authorize → transform → validate → cache; `.from(ctx)` factory + tuple-arity-3 router sugar |
| `rule` / `z` | Validation builders (thin Zod façade); raw Zod always interops |
| `registerRule` / `replaceRule` | Named custom rules for `rule.custom(name, args?)` |

## Sub-path imports

```ts
import { Router } from '@strav/http/router'
import { HttpContext } from '@strav/http/context'
import { composeMiddleware } from '@strav/http/middleware'
```

Consumer apps should generally import from the root barrel:

```ts
import { Router, HttpKernel } from '@strav/http'
```

## Documentation

- [`api.md`](./api.md) — every public export, signature, semantics.
- [`guides/routing.md`](./guides/routing.md) — patterns, groups, named routes, handler shapes (closure / single-action / tuple), middleware composition.
- [`guides/built-ins.md`](./guides/built-ins.md) — `security_headers`, `cors`, `request_log`; the kernel-level request-id; override pattern via `MiddlewareRegistry.replace()`.
- [`guides/requests-and-validation.md`](./guides/requests-and-validation.md) — `FormRequest` lifecycle, dispatch shapes (`.from(ctx)` vs tuple-arity-3), `rule.*` builders, inline refines, registered custom rules, error-shape contract.
