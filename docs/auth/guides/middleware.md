# `auth` and `guest` middleware

`AuthProvider` auto-registers two middleware as factory entries on the `MiddlewareRegistry`. Use them by string name in `config.http.middleware` (global) or `route.middleware(...)` (per-route). The `:` suffix selects a non-default guard.

## `auth` — require an authenticated user

| Reference | Effect |
|---|---|
| `'auth'` | Require auth on the **default** guard (from `config.auth.default`) |
| `'auth:web'` | Require auth on the `web` guard |
| `'auth:api'` | Require auth on the `api` guard |

On miss, throws `AuthError('auth.not-authenticated', 401)`. The default `ExceptionHandler` maps it to:

- JSON requests (or any request that prefers JSON): `401` with `{ error: { code: 'auth.not-authenticated', message: '...' } }`.
- HTML requests: minimal `401` HTML shell (will become a redirect to `config.auth.loginRoute` once `@strav/view` lands).

```ts
router.get('/dashboard', [DashboardController, 'show']).middleware('auth')
router.get('/api/me',    [MeController,        'show']).middleware('auth:api')
```

When `auth` runs, it calls `ctx.auth.populate()` (or `ctx.auth.guard(name).populate()` for the `:name` form). The handler then sees `ctx.auth.user` already populated — no extra await.

## `guest` — require an unauthenticated user

The inverse. Use on login / signup screens so signed-in users don't see them.

| Reference | Effect |
|---|---|
| `'guest'` | Block when authenticated on the default guard |
| `'guest:web'` | Block when authenticated on the `web` guard |

On hit, throws `AuthorizationError('auth.already-authenticated', 403)`.

```ts
router.get('/login',  [AuthController, 'showLogin']).middleware('guest')
router.post('/signup', [AuthController, 'signup'])  .middleware('guest')
```

The 403 status matches the spec ("you're authenticated, you just can't be here") and is what a future redirect (HTML response → `config.auth.dashboardRoute`) will rewrite.

## Ordering inside the chain

The auth/guest middleware run *after* the kernel's context enricher (which populates `ctx.auth`) and *after* any global middleware that don't care about auth. The typical chain:

```
global:           security_headers → cors → request_log
route (per route): auth → handler
                  └→ guest → handler  (for opt-out routes)
```

`auth` and `guest` themselves can be made global if every route in your app requires auth:

```ts
// config/http.ts
export default {
  middleware: ['security_headers', 'cors', 'request_log', 'auth'],
}
```

— but most apps prefer per-route opt-in, with a small set of public routes (`guest` on login/signup, no middleware on health checks).

## Reading the user from the handler

After `auth` middleware runs:

```ts
import { assertAuth } from '@strav/auth'

async show(ctx: HttpContext): Promise<Response> {
  const auth = assertAuth(ctx)        // narrows ctx.auth to AuthContext
  const user = auth.user!             // safe: 'auth' middleware threw if null
  return ctx.response.ok({ id: user.getAuthIdentifier() })
}
```

Two equivalent patterns:

- `auth.user!` — non-null assertion. Lints clean only if biome's `noNonNullAssertion` is off; the project's strict config flags it.
- `await auth.userOrFail()` — async, returns the user or throws a typed `AuthError`. Always lints clean.

Both produce the same outcome under the `auth` middleware.

## Overriding the built-in middleware

The middleware are registered under the canonical names `'auth'` and `'guest'`. To swap one (e.g., custom guest behavior that redirects HTML responses instead of throwing):

```ts
import { MiddlewareRegistry } from '@strav/http'
import { AUTH_BUILTIN_NAMES } from '@strav/auth'

class RoutesProvider extends ServiceProvider {
  override readonly name = 'routes'
  override readonly dependencies = ['http', 'auth']
  override register(app: Application): void {
    app.resolve(MiddlewareRegistry).replace(
      AUTH_BUILTIN_NAMES.guest,
      myCustomGuestMiddleware,
    )
    // ... routes ...
  }
}
```

Topo sort makes sure this runs before `HttpProvider.boot()` compiles the route plans, so the override lands in time.

## What's not here yet

- **`auth:api,write:leads` scopes** — opaque-token guard with scope checks is a follow-up cut (depends on `@strav/database` for token storage).
- **`policy:Resource,action`** — gate that runs a Policy object. Lands with `@strav/auth/policies`.
- **`verified`** — requires `email_verified_at`. Lands with the email-verification flow.
- **HTML redirect on auth failure** — needs `@strav/view` + the `config.auth.loginRoute` setting.
