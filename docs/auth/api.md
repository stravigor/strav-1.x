# @strav/auth — API Reference

> **Status:** Reflects M2 (foundation + Session + Token) **plus** the auth-extras slice on `master` (unreleased): `MagicLinkManager`, `EmailVerification` + `verified` middleware, TOTP helpers, `Gate` + policies + `policy` middleware + `ctx.auth.authorize / can / cannot`. JWT lands post-1.0.

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

  // Policy/Gate integration (no-op when no Gate is bound):
  authorize(ability: string, ...args: unknown[]): Promise<void>   // throws AuthorizationError on deny
  can(ability: string, ...args: unknown[]): Promise<boolean>
  cannot(ability: string, ...args: unknown[]): Promise<boolean>
}
```

The `authorize` / `can` / `cannot` methods delegate to the `Gate` resolved at boot. They call `populate()` first so handlers don't need to `await ctx.auth.check()` separately. `can` returns `false` when no Gate is bound; `authorize` throws a plain `Error` (developer mistake — wire `Gate` in your provider). See [`guides/policies.md`](./guides/policies.md).

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

  authenticate(ctx): Promise<U | null>
  login(ctx, user, opts?): Promise<void>
  logout(ctx): Promise<void>
  regenerate(ctx): Promise<Session | null>     // session-id rotation
  touch(ctx): Promise<Session | null>           // sliding-window expiry
  killAllForUser(userId): Promise<number>       // bulk revoke
}
```

- **`authenticate(ctx)`** — reads the cookie, calls `sessions.findValid(id)` (one round-trip), then `userResolver(session.user_id)`. Returns `null` for missing cookie / stale row / expired / deleted user.
- **`login(ctx, user)`** — mints a ULID, inserts the row, sets the cookie. Cookie `expires` matches the row's `expires_at`.
- **`logout(ctx)`** — deletes the row (if any), clears the cookie.
- **`regenerate(ctx)`** — rotate the session id (session-fixation prevention). Mints a fresh row carrying the same `user_id` + `payload`, deletes the old, sets the new cookie. Returns the new `Session` or `null` if no valid session was bound. Call right after credential verification in a login route.
- **`touch(ctx)`** — bump `expires_at` to `now + ttlSeconds` for the current request's session (sliding-window expiry). Returns the updated `Session` or `null` if no valid session. Call from an "active user" middleware after the user has been authenticated.
- **`killAllForUser(userId)`** — bulk-revoke every session for a user. Used by "log out everywhere" + password-change flows. Returns the affected row count. Does NOT touch the current request's cookie — call `logout(ctx)` separately for that.

Cookie defaults: `httpOnly: true`, `sameSite: 'lax'`, `secure: true`, `path: '/'`.

Usually constructed by `AuthProvider` from the `'session'` driver config — apps don't `new SessionGuard(…)` directly. See [`guides/sessions.md`](./guides/sessions.md) for the full setup + production checklist.

### `Session` Model

```ts
class Session extends Model {
  static schema = sessionSchema
  id: string
  user_id: string
  expires_at: Date
  payload: Record<string, unknown> | null    // jsonb key/value bag
  created_at: Date
  updated_at: Date

  isValid(now?: Date): boolean   // `expires_at > now`
}
```

`payload` holds request-scoped state (flash messages, CSRF tokens, locale, "remember me" markers). Apps patch it via `SessionRepository.patchPayload(...)` rather than mutating + calling `update()` directly — the helper handles the shallow merge and fires the standard `session.updating` / `session.updated` events.

### `sessionSchema`

The `@strav/database` Schema for the `session` table. Register it on your app's `SchemaRegistry` + migrate (`emitCreateTable(sessionSchema)`). The schema is bare-minimum on purpose — payload, last-seen, IP/UA columns land in follow-up slices.

### `SessionRepository`

```ts
class SessionRepository extends Repository<Session> {
  findValid(id: string, now?: Date): Promise<Session | null>
  deleteExpired(now?: Date): Promise<number>
  patchPayload(session: Session, partial: Record<string, unknown>): Promise<Session>
  killAllForUser(userId: string): Promise<number>
  // …plus all Repository methods: find / findOrFail / findMany / create / update / delete / query / etc.
}
```

`@inject()`-marked; the container resolves `PostgresDatabase` + `EventBus` automatically. `patchPayload` shallow-merges `partial` into `session.payload ?? {}` and routes through `this.update(...)` so `updated_at` bumps + `session.updating` / `session.updated` events fire normally. Apps that need to "kill all sessions for a user" use `.query().where('user_id', userId).get()` then delete each — a `killAllForUser` helper lands when the use case shows up.

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
  @hidden hash: string          // SHA-256 hex of the secret half — omitted from toJSON
  expires_at: Date | null       // null = never expires
  created_at: Date
  updated_at: Date

  isValid(now?: Date): boolean  // `expires_at === null || expires_at > now`
}
```

`hash` is marked `@hidden` so `JSON.stringify(token)` excludes it — token-list API responses can return the row directly without leaking the stored hash. See [`@strav/database`'s `@hidden` decorator](../database/guides/model_decorators.md).

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
| `'verified'` | Require `ctx.auth.user.email_verified_at != null`. Run after `auth`. |
| `'policy:<key>,<ability>'` | Load resource via `gate.resource(key, loader)` then call `ctx.auth.authorize(ability, resource)`. Run after `auth`. |

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

`name = 'auth'`, `dependencies = ['config', 'http']`. Binds `Hasher`, `SessionRepository`, `AccessTokenRepository`, `AuthManager`, `Gate`, `MagicLinkManager`, `EmailVerification`; auto-registers `auth` / `guest` / `policy` / `verified` middleware; installs a `ctx.auth` enricher on `HttpKernel` (with `gateRef` injected when `Gate` is bound). `boot()` eagerly resolves the manager so config errors surface at boot.

Extras-related config:

```ts
// config/auth.ts
export default {
  default: 'session',
  guards: { /* … */ },
  hasher: { /* … */ },
  magic: { baseUrl?: string; path?: string },          // MagicLinkManager
  verification: { baseUrl?: string; ttlSeconds?: number; path?: string },   // EmailVerification
}
```

`EmailVerification` reads `config.app.key` for the HMAC secret — missing key throws `ConfigError` at boot. `magic.baseUrl` / `verification.baseUrl` default to `config.app.url`.

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

## `MagicLinkManager`

Single-use passwordless sign-in links. Backed by the `strav_magic_links` table (`magicLinkSchema`). `AuthProvider` registers `MagicLinkManager` as a container singleton when `config.auth.magic.baseUrl` (or `config.app.url`) is set.

```ts
class MagicLinkManager {
  constructor(opts: { db: Database; baseUrl?: string; path?: string })

  create(userId: string, options?: CreateMagicLinkOptions): Promise<string>
  consume(token: string): Promise<ConsumedMagicLink>
}

interface CreateMagicLinkOptions {
  ttl?: string | number    // '15m' | '1h' | '7d' | seconds. Default '15m'
  redirectTo?: string       // stored on the row, returned by consume()
  baseUrl?: string          // per-call override
  path?: string             // default '/auth/magic'
}

interface ConsumedMagicLink { userId: string; redirectTo: string | null }
```

- **`create(userId, opts?)`** — inserts a row with a 32-byte random hex token (256-bit entropy), returns the full URL to email. Throws `MagicLinkError` if no `baseUrl` is configured.
- **`consume(token)`** — looks up the row, rejects when missing / `used_at != null` / `expires_at` past, atomically fills `used_at`, returns `{ userId, redirectTo }`.

`MagicLinkError` carries one of three discriminator codes in its `context`: `'invalid'`, `'used'`, `'expired'`. Status is 400 (treat as a client error — the user clicked a stale link).

Token storage is plaintext on purpose: the security boundary is single-use + short TTL + email delivery, not token secrecy. Schema is `strav_magic_links` with `token UNIQUE` for the consume lookup. See [`guides/magic-links.md`](./guides/magic-links.md).

## `EmailVerification`

Stateless, signed verification URLs. Unlike magic links (which authenticate), these only prove email ownership. **No DB table** — the token is `<userId>.<timestamp>.<hmac-sha256>` keyed on `config.app.key`.

```ts
class EmailVerification {
  constructor(opts: { appKey: string; baseUrl?: string; ttlSeconds?: number; path?: string })

  signedUrl(userId: string, options?: EmailVerificationOptions): string
  verify(token: string, options?: EmailVerificationOptions): EmailVerificationResult
}

interface EmailVerificationOptions {
  ttlSeconds?: number      // default 86400 (24h)
  path?: string             // default '/auth/verify'
  now?: number              // override for deterministic tests
}

interface EmailVerificationResult { userId: string }
```

`verify` does constant-time signature compare + TTL check and throws `EmailVerificationError` (status 400; `context.code` is `'invalid'` or `'expired'`).

Tradeoff vs. `MagicLinkManager`: stateless = no DB write, no per-token revoke. Apps that need to invalidate a verification link (e.g. user changes email) should rotate `config.app.key` or fall back to `MagicLinkManager`.

`AuthProvider` registers `EmailVerification` as a singleton when `config.app.key` is present — missing key throws `ConfigError` at boot.

### `verifiedMiddleware` / `EmailNotVerifiedError`

Registered on the middleware registry as `'verified'`. Reads `ctx.auth.user.email_verified_at` and throws `EmailNotVerifiedError` (`auth.email-not-verified`, status 403) when null. **Must run after `'auth'`** — it does not authenticate the user, only gates verified ones.

```ts
router.get('/billing', handler).middleware(['auth', 'verified'])
```

See [`guides/verification.md`](./guides/verification.md).

## TOTP

RFC 6238 helpers — pure `node:crypto`, no external dep. Three top-level functions cover the enroll-and-verify lifecycle:

```ts
function generateSecret(): string                                       // base32, 160 bits
function qrUri(secret: string, account: string, issuer: string): string // otpauth://totp/…
function verifyTotp(secret: string, code: string, options?: TotpOptions): boolean

interface TotpOptions {
  digits?: number    // default 6
  window?: number    // ± steps tolerated for clock skew. Default 1
  period?: number    // step seconds. Default 30
}

// Plus base32 primitives used internally — exposed for tests / custom flows:
function base32Encode(buf: Buffer | Uint8Array): string
function base32Decode(str: string): Buffer
```

- **`generateSecret()`** — 20 random bytes encoded as RFC 4648 base32 (no padding). Store on the user row (apps typically encrypt with `@encrypt` from `@strav/database`).
- **`qrUri(secret, account, issuer)`** — the `otpauth://` URI compatible with Google Authenticator / Authy / 1Password. Render as a QR code with any QR library.
- **`verifyTotp(secret, code)`** — checks the current 30s window ±1 step. Returns `false` on mismatch — caller decides retry policy / account lockout.

No `Hasher`-style class or container binding — these are pure functions. Apps own the user-facing rate-limiting and recovery-code generation. See [`guides/totp.md`](./guides/totp.md).

## `Gate` — policies + abilities

Central authorization registry. `AuthProvider` registers `Gate` as a container singleton, the context enricher injects it into `AuthContext.gateRef`, and the `policy:resource,ability` middleware factory resolves it on demand.

```ts
class Gate {
  policy<T>(resourceClass: new (...a: any[]) => T, policyClass: PolicyClass): this
  define(ability: string, fn: AbilityFn): this
  resource(key: string, loader: ResourceLoader): this   // for `policy` middleware

  authorize(ability, user, ...args): Promise<void>      // throws AuthorizationError on deny
  can(ability, user, ...args): Promise<boolean>
  cannot(ability, user, ...args): Promise<boolean>
}

type PolicyMethod  = (user: Authenticatable, ...args: unknown[]) => boolean | Promise<boolean>
type AbilityFn     = (user: Authenticatable, ...args: unknown[]) => boolean | Promise<boolean>
type PolicyClass   = new (...a: any[]) => any
type ResourceLoader = (id: string) => Promise<unknown>
```

Two authorization modes share the same surface:

1. **Policy classes** — when the first arg to `authorize` is an object, the gate uses its constructor as the policy key. The `ability` string names the method on the policy class:

   ```ts
   class LeadPolicy {
     async update(user: User, lead: Lead) { return lead.owner_id === user.id }
     async destroy(user: User, lead: Lead) { return user.role === 'admin' }
   }
   gate.policy(Lead, LeadPolicy)
   await ctx.auth.authorize('update', lead)   // → LeadPolicy.update(user, lead)
   ```

2. **Gate ability functions** — standalone, not tied to a resource class:

   ```ts
   gate.define('admin.access', (user) => user.role === 'admin')
   await ctx.auth.can('admin.access')         // → AbilityFn(user)
   ```

`evaluate` order: policy lookup first when args[0] is an object; falls back to a defined ability; otherwise throws `AuthorizationError('No policy or gate found for ability "…"')`.

`AuthorizationError` extends `StravError` with `code: 'auth.unauthorized'`, `status: 403`. `can` swallows it (returns `false`); `authorize` propagates it.

### `policy:resource,ability` middleware

Registered as a factory entry on the `MiddlewareRegistry`. Pattern: `policy:<resourceKey>,<ability>`.

```ts
gate.resource('leads', (id) => leadRepo.find(id))

router.put('/leads/:id', [LeadController, 'update'])
  .middleware(['auth', 'policy:leads,update'])
```

On invocation: pulls `:id` from `ctx.request.params`, calls the registered loader, returns `404` when the loader returns `null`, otherwise calls `ctx.auth.authorize(ability, resource)`.

Throws plain `Error` (developer mistake) when the route has no `:id` param or `ctx.auth` is missing — apply `auth` middleware before `policy`. See [`guides/policies.md`](./guides/policies.md).
