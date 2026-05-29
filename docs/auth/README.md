# @strav/auth

Authentication primitives for Strav 1.0 — `Hasher` (argon2id), guards, the per-request `ctx.auth` façade, and `auth` / `guest` middleware.

> **Status: 1.0.0-alpha.9 — M2 + auth-extras slice (magic links, email verification, TOTP, policies / gates).**
> Shipping: **Hasher** (Bun.password / argon2id), **Authenticatable** contract, **Guard** + **AuthManager** + **AuthContext** (`ctx.auth`), **MemoryGuard** (dev/test), **SessionGuard** + lifecycle helpers (`regenerate` / `touch` / `killAllForUser`) + **Session** with `payload jsonb` + **SessionRepository.patchPayload**, **TokenGuard** + **AccessToken** Model / Schema / Repository, **auth / guest middleware**.
> Auth-extras (this slice, unreleased): **`MagicLinkManager`** + `strav_magic_links` schema (single-use passwordless links), **`EmailVerification`** (stateless HMAC-signed URLs) + **`verified` middleware**, **TOTP** helpers (`generateSecret` / `qrUri` / `verifyTotp`), **`Gate`** + policy classes + `'policy:resource,ability'` middleware + `ctx.auth.authorize` / `can` / `cannot`.
> Deferred: **auto-flush payload middleware**, **session cleanup command** (`sessions:gc`), **token abilities / scopes**, **token `last_used_at` updates**. **JWT** driver opt-in: post-1.0.

## Install

```bash
bun add @strav/auth
```

Peer deps: `@strav/kernel`, `@strav/http`, `@strav/database` (all in the workspace).

## Minimal app

```ts
// bin/strav.ts
import { Application, ConfigProvider, LoggerProvider, ServiceProvider } from '@strav/kernel'
import { HttpKernel, HttpProvider, Router } from '@strav/http'
import { AuthProvider, MemoryGuard } from '@strav/auth'
import loggerConfig from '../config/logger.ts'
import authConfig from '../config/auth.ts'

const app = new Application()

// Apps bind their guards on the container; AuthProvider resolves them by name.
app.singleton('memory_guard', () => new MemoryGuard({
  name: 'memory',
  userResolver: (id) => userRepository.byId(id),
}))

app.useProviders([
  new ConfigProvider({ logger: loggerConfig, auth: authConfig }),
  new LoggerProvider(),
  new HttpProvider(),
  new AuthProvider(),
])

await app.start()
app.resolve(HttpKernel).serve({ port: 3000 })
```

```ts
// config/auth.ts
export default {
  default: 'memory',
  guards: {
    memory: { driver: 'custom', service: 'memory_guard' },
  },
  hasher: { memoryCost: 65536, timeCost: 3 },
}
```

## What's here

| Symbol | Purpose |
|---|---|
| `Hasher` | Argon2id wrapper over `Bun.password`; `make` / `verify` / `needsRehash` |
| `Authenticatable` | Interface user models implement (`getAuthIdentifier` + `getAuthPassword`) |
| `isAuthenticatable` | Type-guard for the contract |
| `Guard` | Strategy interface — `authenticate(ctx)` / `login(ctx, user, opts?)` / `logout(ctx)` |
| `AuthManager` | Registry of named guards; resolved from `config.auth.guards` |
| `AuthContext` | Per-request façade attached as `ctx.auth`; delegates to the default guard view |
| `AuthGuardView` | The per-guard view returned by `ctx.auth.guard(name)`; caches user per-request |
| `MemoryGuard` | In-process guard for tests + dev (cookie → in-memory map) |
| `SessionGuard` | Production cookie-based guard backed by the `session` table; ships `regenerate` / `touch` / `killAllForUser` lifecycle helpers |
| `Session` | Session row Model — id, user_id, expires_at, payload (jsonb), timestamps |
| `sessionSchema` | The `@strav/database` Schema for the `session` table — register + migrate |
| `SessionRepository` | Repository<Session> with `findValid(id)` / `deleteExpired(now?)` / `patchPayload(session, partial)` / `killAllForUser(userId)` |
| `TokenGuard` | Bearer-token guard backed by the `access_token` table |
| `AccessToken` | Token row Model — id, user_id, name, hash, expires_at, timestamps |
| `accessTokenSchema` | The `@strav/database` Schema for the `access_token` table — register + migrate |
| `AccessTokenRepository` | Repository<AccessToken> with `createToken` / `findByPlaintext` / `revokeAllForUser` |
| `authMiddleware` / `guestMiddleware` | Functions returned by the registered `auth` / `guest` middleware factories |
| `AUTH_BUILTIN_NAMES` | String-key constants used in `config.http.middleware` and `route.middleware('...')` |
| `AuthProvider` | ServiceProvider that binds Hasher + AuthManager and auto-wires `ctx.auth` |
| `assertAuth(ctx)` | Helper that narrows `ctx.auth` to a non-null `AuthContext` |
| `MagicLinkManager` | Create + consume single-use passwordless sign-in URLs; backed by `strav_magic_links` |
| `magicLinkSchema` / `MagicLinkError` | Schema for the magic-links table + typed error (`auth.magic-link-error`) |
| `EmailVerification` | Stateless HMAC-signed verification URLs — `signedUrl(userId)` / `verify(token)` |
| `EmailNotVerifiedError` / `verifiedMiddleware` | `verified` middleware that checks `user.email_verified_at` |
| `Gate` | Registry for policy classes + standalone abilities; backs `ctx.auth.authorize / can / cannot` |
| `makePolicyMiddleware` / `AuthorizationError` | Factory used by the `policy:resource,ability` middleware + typed 403 error |
| `generateSecret` / `qrUri` / `verifyTotp` | TOTP (RFC 6238) helpers — no external dep, base32 secret format |

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/setup.md`](./guides/setup.md) — wiring AuthProvider, building a custom guard, the `config.auth` shape, the `ctx.auth` lifecycle.
- [`guides/middleware.md`](./guides/middleware.md) — `auth` / `guest` middleware (with the `:guardName` factory form), error responses, ordering.
- [`guides/sessions.md`](./guides/sessions.md) — SessionGuard / Session schema + migration, what's deferred (sliding-window expiry, payload column, session rotation, cleanup command), production checklist.
- [`guides/tokens.md`](./guides/tokens.md) — TokenGuard / AccessToken schema + migration, token format, minting and verifying, what's deferred (abilities/scopes, `last_used_at`), production checklist.
- [`guides/magic-links.md`](./guides/magic-links.md) — `MagicLinkManager` flow, schema + migration, TTL parsing, pairing with `signal` for the email job.
- [`guides/verification.md`](./guides/verification.md) — `EmailVerification` (stateless HMAC URLs) + `verified` middleware, comparison with magic links.
- [`guides/totp.md`](./guides/totp.md) — TOTP enroll / verify lifecycle, base32 secret storage with `@encrypt`, recovery-code shape.
- [`guides/policies.md`](./guides/policies.md) — `Gate`, policy classes, gate ability functions, the `policy:resource,ability` middleware, `ctx.auth.authorize` / `can` / `cannot`.
