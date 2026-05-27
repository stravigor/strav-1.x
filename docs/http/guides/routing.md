# Routing — patterns, handlers, middleware

The kernel has three responsibilities at request time: find a route, run its middleware onion, hand off to a handler. This guide walks through each in the order you'd encounter them when wiring up a real app.

## Register routes in a provider

Routes need to land **before** `HttpProvider.boot()` runs (boot compiles the trie). The shape that survives growth: declare a small `RoutesProvider` that depends on `'http'` and adds routes in its `register()`:

```ts
// app/providers/routes_provider.ts
import { type Application, ServiceProvider } from '@strav/kernel'
import { Router } from '@strav/http'
import { UserController } from '../http/controllers/user_controller.ts'

export class RoutesProvider extends ServiceProvider {
  override readonly name = 'routes'
  override readonly dependencies = ['http']

  override register(app: Application): void {
    const router = app.resolve(Router)
    router.group({ prefix: '/api', name: 'api.' }, (api) => {
      api.get('/users', [UserController, 'index']).name('users.index')
      api.get('/users/:id', [UserController, 'show']).name('users.show')
      api.post('/users', [UserController, 'store']).name('users.store').middleware('auth')
    })
  }
}
```

Topo sort runs the register phase end-to-end before any boot — so `Router` is bound (by `HttpProvider.register`) by the time `RoutesProvider.register` runs, and the trie is compiled (by `HttpProvider.boot`) after all routes are in.

## Path syntax cheat-sheet

```
/users                    static
/users/:id                required param → ctx.request.params.id
/users/:id?               optional       → params.id is absent for /users
/files/*path              wildcard       → params.path = 'a/b/c.txt' for /files/a/b/c.txt
/tenants/:tenant/users/:id   multiple params
```

Static segments beat params; params beat wildcards. Duplicate (method, pattern) pairs throw at compile time.

## Three handler shapes

```ts
// 1. Closure — no DI; quick endpoints.
router.get('/health', (ctx) => ctx.response.ok({ ok: true }))

// 2. Single-action class — DI but only one action per class.
@inject()
class HealthCheck {
  constructor(private db: Database) {}
  handle(ctx: HttpContext): Response {
    return ctx.response.ok({ db: this.db.ping() })
  }
}
router.get('/health', HealthCheck)

// 3. Tuple [Class, methodName] — DI + many actions per controller. The
//    method name is constrained by TS to callable members of the class, so
//    typos fail at compile time.
@inject()
class UserController {
  constructor(private users: UserRepository) {}
  async index(ctx: HttpContext): Promise<Response> { ... }
  async show(ctx: HttpContext): Promise<Response> { ... }
}
router.get('/users',    [UserController, 'index'])
router.get('/users/:id', [UserController, 'show'])
```

The class is `make()`d from the **request scope** — `@inject()`'d deps resolve fresh per request when bound `scoped`; bound `singleton` deps share.

### Return value coercion

Whatever a closure / action returns gets normalized:

| Returned | Becomes |
|---|---|
| `Response` | itself |
| `null` / `undefined` | 204 No Content |
| Anything else | `application/json` 200, body is `JSON.stringify(value)` |

Use `ctx.response.*` factories when you need specific status codes or headers.

## Groups

```ts
router.group({ prefix: '/admin', middleware: ['auth', 'role:admin'], name: 'admin.' }, (admin) => {
  admin.get('/dashboard', [AdminController, 'dashboard']).name('dashboard')
  // → GET /admin/dashboard, name "admin.dashboard",
  //   middleware ['auth', 'role:admin']
})
```

Nesting works:

```ts
router.group({ prefix: '/api', name: 'api.' }, (api) => {
  api.group({ prefix: '/v1', name: 'v1.', middleware: 'throttle' }, (v1) => {
    v1.get('/users', [UserController, 'index']).name('users.index')
    // → GET /api/v1/users, name "api.v1.users.index", middleware ['throttle']
  })
})
```

Prefixes concatenate, names concatenate, middleware accumulates (outer first).

## Middleware

Two flavors — both can short-circuit by returning a Response without calling `next()`.

```ts
// Function
const requestId: MiddlewareFn = async (ctx, next) => {
  ctx.state.requestId = crypto.randomUUID()
  return next()
}

// Class (DI + optional `terminate` hook)
@inject()
class RequestLog implements MiddlewareClass {
  constructor(private log: Logger) {}
  async handle(ctx: HttpContext, next: NextFn): Promise<Response> {
    ctx.state._start = Date.now()
    return next()
  }
  async terminate(ctx: HttpContext, response: Response): Promise<void> {
    this.log.info('http.request', {
      method: ctx.request.method,
      path: ctx.request.path,
      status: response.status,
      duration_ms: Date.now() - ctx.state._start,
    })
  }
}
```

Register them by name once, reference everywhere:

```ts
// In a provider that depends on 'http':
const reg = app.resolve(MiddlewareRegistry)
reg.register('request_id', requestId)
reg.register('request_log', RequestLog)
reg.register('throttle', (limit?: string, window?: string) => makeThrottle(limit, window), {
  factory: true,
})

// At the route:
router.get('/feed', [FeedController, 'show']).middleware('throttle:60,1m')
```

Global middleware goes in `config.http.middleware` and runs on every request, before any route-level middleware.

### Order

For a request that resolves a route:

```
global middleware (in config order)
  → group middleware (outer to inner)
    → route middleware (in declaration order)
      → handler
```

Each layer's "after `next()`" runs in reverse order on the way out. `terminate(ctx, response)` fires after the response is sent — best-effort, errors are logged but never propagate.

## Named routes

```ts
router.post('/users', [UserController, 'store']).name('users.store')

import { resolveRoute } from '@strav/http'
resolveRoute(router, 'users.store')                            // → '/users'
resolveRoute(router, 'users.show', { id: 42 })                 // → '/users/42'
resolveRoute(router, 'users.show', { id: 42 }, { abs: true, host: 'api.example.com' })
//   → 'https://api.example.com/users/42'
```

Extra params append as query string. Missing required params throw `ConfigError`; optional params can be omitted (the segment drops out).

## Error handling

Every throw inside a handler or middleware funnels through `ExceptionHandler.renderHttp`. `StravError` subclasses map to their `.status`; plain `Error` is 500. See [`docs/http/api.md#exceptionhandler`](../api.md#exceptionhandler) for the table.

Customize by subclassing:

```ts
class Handler extends ExceptionHandler {
  override renderHttp(error: Error, ctx: HttpContext): Response | Promise<Response> {
    if (this.wantsHtmlError(ctx)) return ctx.response.view(`errors/${this.statusFor(error)}`, { error })
    return super.renderHttp(error, ctx)
  }
}

app.singleton(ExceptionHandler, (c) => new Handler(c.resolve(Logger)))
```

Bind your subclass **before** `HttpProvider.register()` runs (in your bootstrap, or in a provider that runs before `'http'`).

## Testing

`HttpKernel.handle(request)` is the test entry — no Bun server needed:

```ts
const res = await app.resolve(HttpKernel).handle(
  new Request('http://localhost/users/42', { headers: { accept: 'application/json' } }),
)
expect(res.status).toBe(200)
expect(await res.json()).toMatchObject({ id: '42' })
```

The kernel creates a fresh request scope per call, so scoped bindings (`Counter`, `RequestId`, etc.) reset between requests.

Headers worth setting in tests: `accept: application/json` (forces JSON in the default ExceptionHandler), `content-type` (chooses body parser), `cookie`.
