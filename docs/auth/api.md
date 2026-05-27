# @strav/auth — API Reference

> **Status:** Reflects what's implemented as of M2 (auth foundation slice) — Hasher, Authenticatable, Guard, AuthManager, AuthContext, MemoryGuard, auth/guest middleware, AuthProvider, assertAuth. SessionGuard / TokenGuard / magic links / TOTP / email verification / JWT land in follow-up cuts (most need `@strav/database`).

## `Hasher`

Argon2id wrapper backed by `Bun.password`. Apps resolve `Hasher` from the container; `AuthProvider` constructs it from `config.auth.hasher`.

```ts
import { Hasher } from '@strav/auth'

const hasher = app.resolve(Hasher)

const hash = await hasher.make('correct-horse-battery-staple')
// → '$argon2id$v=19$m=65536,t=3,p=4$...'

const ok = await hasher.verify('correct-horse-battery-staple', hash)
// → true (or false on mismatch / malformed input — never throws)

if (hasher.needsRehash(user.password_hash)) {
  user.password_hash = await hasher.make(plaintext)
  await users.save(user)
}
```

| Method | Behavior |
|---|---|
| `make(plaintext)` | Returns the PHC-encoded argon2id string for storage |
| `verify(plaintext, hash)` | Constant-time match. Returns `false` for wrong password, empty input, or malformed hash (no throws) |
| `needsRehash(hash)` | `true` when stored hash is non-argon2id, has weaker `memoryCost`, or weaker `timeCost` than the current `HasherOptions` |

**Options** (`config.auth.hasher`):

```ts
interface HasherOptions {
  memoryCost?: number    // default 65536 (KiB)
  timeCost?: number      // default 3
}
```

Defaults follow OWASP 2024.

## `Authenticatable`

```ts
interface Authenticatable {
  getAuthIdentifier(): string   // primary key (typically a ULID string)
  getAuthPassword(): string     // hashed password column
}
```

Any object exposing the two methods is `Authenticatable`. No mixin required.

`isAuthenticatable(value)` is the runtime type-guard.

## `Guard`

```ts
interface Guard<U extends Authenticatable = Authenticatable> {
  readonly name: string
  authenticate(ctx: HttpContext): U | null | Promise<U | null>
  login(ctx: HttpContext, user: U, options?: LoginOptions): void | Promise<void>
  logout(ctx: HttpContext): void | Promise<void>
}
```

Strategy for identifying a user on a request. Each impl recovers from whatever the wire carries — session cookie, bearer token, JWT. Apps bind their guard on the container under a string key and reference it from `config.auth.guards`:

```ts
app.singleton('memory_guard', () => new MemoryGuard({ … }))

// config/auth.ts
export default {
  default: 'memory',
  guards: { memory: { driver: 'custom', service: 'memory_guard' } },
}
```

`LoginOptions { remember?: boolean }`. Guards that don't support remember-me ignore it.

## `AuthManager`

Built once at boot by `AuthProvider`. Resolves guards by name.

```ts
class AuthManager {
  readonly default: string

  register(guard: Guard): this
  replace(guard: Guard): this
  guard(name?: string): Guard
  list(): readonly Guard[]
}
```

`guard()` with no args returns the default guard.

## `AuthContext` / `AuthGuardView`

`ctx.auth` is an `AuthContext` (the default-guard view). `ctx.auth.guard(name)` returns an `AuthGuardView` for the named guard — both share the same surface for `user / check / userOrFail / login / logout`.

```ts
interface AuthContext {
  readonly user: U | null

  check(): Promise<boolean>
  userOrFail(): Promise<U>        // throws AuthError 'auth.not-authenticated'
  login(user: U, opts?: LoginOptions): Promise<void>
  logout(): Promise<void>
  populate(): Promise<void>       // force the default guard to authenticate now
  guard(name: string): AuthGuardView
}
```

Caching is keyed by guard. Calling `ctx.auth.guard('memory')` twice within a request returns the same view — and if `'memory'` IS the default guard, `ctx.auth.guard('memory')` returns a view that shares cache with `ctx.auth` itself. So `auth:default-name` middleware populating the view also populates `ctx.auth.user`.

## `MemoryGuard`

In-process guard for tests + dev. Holds `cookie value → user identifier` in a module-level map.

```ts
class MemoryGuard<U extends Authenticatable> implements Guard<U> {
  constructor(options: {
    name?: string                 // default 'memory'
    cookieName?: string           // default 'strav_memory_session'
    userResolver: (id: string) => Authenticatable | null | Promise<…>
  })

  static clearAllSessions(): void   // test tear-down
}
```

**Not for production** — state is per-process, dies on restart, and the sessions map grows unbounded. The real `SessionGuard` ships with `@strav/database` (Postgres-backed storage + TTL); the real `TokenGuard` ships in the same milestone.

## Middleware — `auth` / `guest`

Both registered as **factory** entries on the `MiddlewareRegistry`. The `:` suffix on the registry name selects the guard:

| Reference | Effect |
|---|---|
| `'auth'` | Require auth on the default guard |
| `'auth:memory'` | Require auth on the `memory` guard |
| `'guest'` | Require *unauthenticated* on the default guard |
| `'guest:memory'` | Require unauthenticated on the `memory` guard |

```ts
// Per-route:
router.get('/dashboard', [DashboardController, 'show']).middleware('auth')
router.get('/login',     [AuthController, 'showLogin']).middleware('guest')
router.get('/api/me',    [MeController, 'show']).middleware('auth:api')

// Global:
// config/http.ts
export default { middleware: ['security_headers', 'cors', 'request_log'] }
```

On miss:
- `auth` → throws `AuthError('auth.not-authenticated', 401)`. Default ExceptionHandler renders 401 JSON / minimal HTML.
- `guest` → throws `AuthorizationError('auth.already-authenticated', 403)`.

Both middleware short-circuit by returning the thrown error through the kernel's exception path; the controller never runs.

## `AuthProvider`

`name = 'auth'`, `dependencies = ['config', 'http']`. Binds `Hasher`, `AuthManager`; auto-registers `auth` / `guest` middleware; installs a `ctx.auth` enricher on `HttpKernel`. `boot()` eagerly resolves the manager so config errors surface at boot.

```ts
interface AuthConfigShape {
  default: string
  guards: Record<string, GuardConfigEntry>
  hasher?: HasherOptions
}

type GuardConfigEntry =
  | { driver: 'custom'; service: string }
  // Future: 'session' | 'token' | 'jwt' as their drivers land.
```

Each guard's `name` property MUST match its config key — the provider validates this at boot.

## `assertAuth(ctx)`

```ts
function assertAuth(ctx: HttpContextApi): AuthContext
```

Helper that narrows `ctx.auth` from `AuthContext | undefined` to `AuthContext`. Same intent as `ctx.auth!` but doesn't trip `noNonNullAssertion` lint and produces a clear error if `AuthProvider` wasn't wired:

```ts
import { assertAuth } from '@strav/auth'

async function show(ctx: HttpContext) {
  const auth = assertAuth(ctx)
  const user = await auth.userOrFail()
  return ctx.response.ok(user)
}
```

If the route already has the `auth` middleware applied, `assertAuth` never throws — the middleware has already verified `ctx.auth` exists and the user is present.
