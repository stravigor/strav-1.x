# @strav/http

Routing, request/response handling, and the HTTP kernel for Strav 1.0.

> **Status: 1.0.0-alpha — M2 in progress.**
> Shipping: **Router** (trie, params, optional params, wildcards, groups, named routes), **HttpContext** (server / request / response namespaces + typed `state`), **HttpRequest** (cached body parsing, query, cookies, content negotiation), **HttpResponse** (factories + pending header/cookie mutations), **middleware composition** (onion, short-circuit, terminating), **MiddlewareRegistry** (name → def, parameterized `name:args` factories), **HttpKernel** (`handle()` / `serve()`), **ExceptionHandler** (default JSON + HTML, `StravError` mapping), **HttpProvider** (container wiring + boot-time precompile).
> Deferred for now: subdomain matching, `FormRequest` + Zod, sessions, Pages auto-router, WS/SSE, opt-in middleware (`auth`, `throttle`, `csrf`, etc.).

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
| `HttpProvider` | Provider that wires `Router`, `MiddlewareRegistry`, `ExceptionHandler`, `HttpKernel` |

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
