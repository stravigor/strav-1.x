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

**Not for production** — state is per-process, dies on restart, and the sessions map grows unbounded. Use `SessionGuard` (below) for production.

## `SessionGuard`

Production cookie-based guard backed by the `session` table.

```ts
class SessionGuard<U extends Authenticatable> implements Guard<U> {
  constructor(options: {
    name?: string                 // default 'session'
    cookieName?: string           // default 'strav_session'
    ttlSeconds?: number           // default 1209600 (14 days)
    secure?: boolean              // default true — set false for HTTP dev
    sessions: SessionRepository
    userResolver: (id: string) => Authenticatable | null | Promise<…>
  })
}
```

- **`authenticate(ctx)`** — reads the cookie, calls `sessions.findValid(id)` (one round-trip), then `userResolver(session.user_id)`. Returns `null` for missing cookie / stale row / expired / deleted user.
- **`login(ctx, user)`** — mints a ULID, inserts the row, sets the cookie. Cookie `expires` matches the row's `expires_at`.
- **`logout(ctx)`** — deletes the row (if any), clears the cookie.

Cookie defaults: `httpOnly: true`, `sameSite: 'lax'`, `secure: true`, `path: '/'`.

Usually constructed by `AuthProvider` from the `'session'` driver config — apps don't `new SessionGuard(…)` directly. See [`guides/sessions.md`](./guides/sessions.md) for the full setup + production checklist.

### `Session` Model

```ts
class Session extends Model {
  static schema = sessionSchema
  id: string
  user_id: string
  expires_at: Date
  created_at: Date
  updated_at: Date

  isValid(now?: Date): boolean   // `expires_at > now`
}
```

### `sessionSchema`

The `@strav/database` Schema for the `session` table. Register it on your app's `SchemaRegistry` + migrate (`emitCreateTable(sessionSchema)`). The schema is bare-minimum on purpose — payload, last-seen, IP/UA columns land in follow-up slices.

### `SessionRepository`

```ts
class SessionRepository extends Repository<Session> {
  findValid(id: string, now?: Date): Promise<Session | null>
  deleteExpired(now?: Date): Promise<number>
  // …plus all Repository methods: find / findOrFail / findMany / create / update / delete / query / etc.
}
```

`@inject()`-marked; the container resolves `PostgresDatabase` automatically. Apps that need to "kill all sessions for a user" use `.query().where('user_id', userId).get()` then delete each — a `killAllForUser` helper lands when the use case shows up.

## `TokenGuard`

Bearer-token guard. Authenticates via an `Authorization: Bearer <token>` header (both the header name and scheme are configurable for non-standard setups).

```ts
class TokenGuard<U extends Authenticatable> implements Guard<U> {
  constructor(options: {
    name?: string                 // default 'token'
    headerName?: string           // default 'authorization'
    scheme?: string               // default 'Bearer' (case-insensitive compare)
    tokens: AccessTokenRepository
    userResolver: (id: string) => Authenticatable | null | Promise<…>
  })
}
```

- **`authenticate(ctx)`** — pulls the bearer value off the configured header, calls `tokens.findByPlaintext(plaintext)` (one PK lookup + constant-time hash compare + expiry check), resolves the user. Returns `null` for missing/bad header, unknown token, hash mismatch, expired row, or deleted user.
- **`login(ctx, user)`** — **throws.** Bearer tokens are minted out-of-band, not by a login flow. Apps mint tokens by calling `AccessTokenRepository.createToken(userId, name, opts?)` from a token-management endpoint.
- **`logout(ctx)`** — revokes (deletes) the current request's token. Idempotent: missing header / invalid token / already-deleted row all no-op.

### Token format

Plaintext shape: `<row_id>|<secret>`.
- `row_id` — the AccessToken row's PK (ULID, 26 chars). Cleartext on the wire; it's just a public identifier.
- `secret` — 32 random bytes, base64url-encoded (~43 chars). Hashed (SHA-256, hex) for storage; the plaintext is shown to the user *once* by `createToken`.

Lookup is a PK hit, not a hash scan. Same pattern Laravel Sanctum, GitHub PATs, and Stripe API keys use.

### `AccessToken` Model

```ts
class AccessToken extends Model {
  static schema = accessTokenSchema
  id: string
  user_id: string
  name: string
  hash: string                  // SHA-256 hex of the secret half
  expires_at: Date | null       // null = never expires
  created_at: Date
  updated_at: Date

  isValid(now?: Date): boolean  // `expires_at === null || expires_at > now`
}
```

### `accessTokenSchema`

The `@strav/database` Schema for `access_token`. Register it on your app's `SchemaRegistry` + migrate (`emitCreateTable(accessTokenSchema)`). See [`guides/tokens.md`](./guides/tokens.md) for the full migration.

### `AccessTokenRepository`

```ts
class AccessTokenRepository extends Repository<AccessToken> {
  createToken(
    userId: string,
    name: string,
    opts?: { expiresInSeconds?: number | null },
  ): Promise<{ plaintext: string; model: AccessToken }>

  findByPlaintext(plaintext: string, now?: Date): Promise<AccessToken | null>

  revokeAllForUser(userId: string): Promise<number>
  // …plus all Repository methods.
}
```

`createToken` returns the plaintext exactly once — store nothing on the server. `findByPlaintext` is what the guard calls per-request: parses `id|secret`, looks up by id, constant-time-compares `sha256(secret)` vs stored hash, checks `expires_at`. `revokeAllForUser` is the "log out everywhere" / "user deleted" helper.

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

`name = 'auth'`, `dependencies = ['config', 'http']`. Binds `Hasher`, `SessionRepository`, `AccessTokenRepository`, `AuthManager`; auto-registers `auth` / `guest` middleware; installs a `ctx.auth` enricher on `HttpKernel`. `boot()` eagerly resolves the manager so config errors surface at boot.

```ts
interface AuthConfigShape {
  default: string
  guards: Record<string, GuardConfigEntry>
  hasher?: HasherOptions
}

type GuardConfigEntry =
  | { driver: 'custom'; service: string }
  | {
      driver: 'session'
      userResolverService: string   // container binding with .find(id)
      cookieName?: string
      ttlSeconds?: number
      secure?: boolean
    }
  | {
      driver: 'token'
      userResolverService: string
      headerName?: string           // default 'authorization'
      scheme?: string               // default 'Bearer'
    }
  // Future: 'jwt' lands with its slice.
```

Both the `'session'` and `'token'` drivers require `@strav/database`'s `DatabaseProvider` to have booted first (their Repositories need `PostgresDatabase`). `userResolverService` must point at a container binding that exposes `.find(id)` — every `@strav/database` Repository does. Misconfigured bindings throw `ConfigError` at boot.

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
