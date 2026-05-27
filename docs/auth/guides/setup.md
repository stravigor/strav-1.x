# Setup — wiring AuthProvider end-to-end

This guide walks through the smallest working auth setup: a user model, a guard, the config, and a controller that signs users in and out.

## 1. The user model

Anything that implements `Authenticatable` works:

```ts
// app/models/user.ts
import type { Authenticatable } from '@strav/auth'

export class User implements Authenticatable {
  constructor(
    public id: string,
    public email: string,
    public passwordHash: string,
    public createdAt: Date,
  ) {}

  getAuthIdentifier(): string {
    return this.id
  }

  getAuthPassword(): string {
    return this.passwordHash
  }
}
```

Two methods. That's it. No mixin, no decorator, no inheritance.

## 2. The user resolver

The guard needs a way to load a user by identifier. Typically that's a repository call:

```ts
// app/repositories/user_repository.ts
import { inject } from '@strav/kernel'

@inject()
export class UserRepository {
  // ... constructor with DB access ...

  byId(id: string): User | null {
    // Replace with your real query when @strav/database lands.
    return this.fakeStore.get(id) ?? null
  }

  byEmail(email: string): User | null {
    return this.fakeStore.byEmail(email) ?? null
  }
}
```

## 3. The guard

Until `@strav/database` ships, `MemoryGuard` is the only built-in. Bind it on the container so AuthProvider can resolve it by string key:

```ts
// app/providers/auth_setup_provider.ts
import { type Application, ServiceProvider } from '@strav/kernel'
import { MemoryGuard } from '@strav/auth'
import { UserRepository } from '../repositories/user_repository.ts'

export class AuthSetupProvider extends ServiceProvider {
  override readonly name = 'auth-setup'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton('web_guard', (c) => new MemoryGuard({
      name: 'web',
      userResolver: (id) => c.resolve(UserRepository).byId(id),
    }))
  }
}
```

## 4. Config

```ts
// config/auth.ts
import type { AuthConfigShape } from '@strav/auth'

const config: AuthConfigShape = {
  default: 'web',
  guards: {
    web: { driver: 'custom', service: 'web_guard' },
  },
  hasher: {
    memoryCost: 65536,
    timeCost: 3,
  },
}

export default config
```

## 5. Bootstrap

Order matters: `AuthSetupProvider` registers its guard before `AuthProvider` reads it from the config.

```ts
// bin/strav.ts
app.useProviders([
  new ConfigProvider({ logger: loggerConfig, http: httpConfig, auth: authConfig }),
  new LoggerProvider(),
  new HttpProvider(),
  new AuthSetupProvider(),   // ← binds 'web_guard' on the container
  new AuthProvider(),        // ← resolves it from config
])
```

The topo sort makes sure `AuthSetupProvider`'s `register()` runs before `AuthProvider.boot()` resolves the manager.

## 6. Sign in / sign out

```ts
// app/http/controllers/auth_controller.ts
import { Hasher, assertAuth } from '@strav/auth'
import { AuthError, inject } from '@strav/kernel'
import type { HttpContext } from '@strav/http'

@inject()
export class AuthController {
  constructor(
    private users: UserRepository,
    private hasher: Hasher,
  ) {}

  async signIn(ctx: HttpContext): Promise<Response> {
    const { email, password } = (await ctx.request.body()) as { email: string; password: string }
    const user = this.users.byEmail(email)
    if (!user || !(await this.hasher.verify(password, user.passwordHash))) {
      throw new AuthError('Invalid credentials.', { code: 'auth.invalid-credentials' })
    }
    await assertAuth(ctx).login(user)
    return ctx.response.ok({ ok: true })
  }

  async signOut(ctx: HttpContext): Promise<Response> {
    await assertAuth(ctx).logout()
    return ctx.response.ok({ ok: true })
  }
}
```

Routes:

```ts
router.post('/auth/sign-in',  [AuthController, 'signIn']).middleware('guest')
router.post('/auth/sign-out', [AuthController, 'signOut']).middleware('auth')
```

## 7. Reading the user

Protected routes read `ctx.auth.user` directly — the `auth` middleware has already populated it:

```ts
async show(ctx: HttpContext) {
  const auth = assertAuth(ctx)
  return ctx.response.ok({
    id: auth.user!.getAuthIdentifier(),
    // … other fields from your User model
  })
}
```

The `!` non-null assertion is safe here because `auth` middleware throws before this code runs if `auth.user` would be null. If you'd rather not assert, use `await auth.userOrFail()` (throws a typed `AuthError`).

## The `ctx.auth` lifecycle

1. **Kernel builds `ctx`** — request, response, server info, request-scoped logger.
2. **AuthProvider's enricher runs** — `ctx.auth = new AuthContext(ctx, manager)`. No guard call yet.
3. **Middleware chain runs**:
   - Global middleware (`security_headers`, `cors`, `request_log`, …) — these don't touch `ctx.auth`.
   - Route middleware (`auth`, `guest`, …) — `auth` calls `ctx.auth.populate()`, which calls the default guard's `authenticate(ctx)` exactly once. If null → 401.
4. **Handler runs** — sees the populated `ctx.auth.user`.
5. **Response leaves** — terminate hooks fire, scope disposes. `AuthContext` is discarded.

Each request gets a fresh `AuthContext`. Login mutates the default guard's cached user; logout clears it.

## Switching guards

```ts
async show(ctx: HttpContext) {
  const auth = assertAuth(ctx)
  const apiToken = auth.guard('api')  // AuthGuardView for the 'api' guard
  if (await apiToken.check()) {
    return ctx.response.ok({ scoped: 'api' })
  }
  return ctx.response.ok({ scoped: auth.user?.getAuthIdentifier() })
}
```

Per-request views are cached — calling `auth.guard('api')` twice returns the same instance, so the `api` guard's `authenticate()` runs at most once per request. When the name matches the default guard, you get the same view that `ctx.auth.*` operates on.

## What's deferred

- **Real session storage** — `SessionGuard` (Postgres) ships with `@strav/database`. Until then, `MemoryGuard` covers tests + local dev.
- **Opaque-token guard** for API auth — same milestone.
- **Magic links**, **TOTP**, **email verification** — same milestone; they all need a persistence layer.
- **JWT driver** — post-1.0, opt-in only (use opaque tokens for first-party API auth).
- **`policy:Resource,action` middleware** — depends on `@strav/auth/policies`, post-foundation.
