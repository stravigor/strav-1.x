# @strav/auth

Authentication primitives for Strav 1.0 — `Hasher` (argon2id), guards, the per-request `ctx.auth` façade, and `auth` / `guest` middleware.

> **Status: 1.0.0-alpha — M2 in progress (foundation + Session + Token slices).**
> Shipping: **Hasher** (Bun.password / argon2id), **Authenticatable** contract, **Guard** + **AuthManager** + **AuthContext** (`ctx.auth`), **MemoryGuard** (dev/test), **SessionGuard** (production cookie-based, DB-backed), **TokenGuard** (bearer-token, DB-backed; `<id>|<secret>` plaintext with SHA-256 hash storage + constant-time verification), **Session** + **AccessToken** Models / Schemas / Repositories, **auth / guest middleware**, **AuthProvider** (auto-wires the lot + `'session'` / `'token'` driver entries).
> Deferred (each its own slice): **magic links**, **email verification**, **TOTP**, **session payload** (flash / CSRF / locale storage on a `jsonb` column), **sliding-window expiry**, **session-fixation prevention** (rotate session id on login), **session cleanup command** (`sessions:gc`), **token abilities / scopes** (lands with auth policies), **token `last_used_at` updates** (needs write batching). **JWT** driver opt-in: post-1.0.

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
| `SessionGuard` | Production cookie-based guard backed by the `session` table |
| `Session` | Session row Model — id, user_id, expires_at, timestamps |
| `sessionSchema` | The `@strav/database` Schema for the `session` table — register + migrate |
| `SessionRepository` | Repository<Session> with `findValid(id)` and `deleteExpired(now?)` |
| `TokenGuard` | Bearer-token guard backed by the `access_token` table |
| `AccessToken` | Token row Model — id, user_id, name, hash, expires_at, timestamps |
| `accessTokenSchema` | The `@strav/database` Schema for the `access_token` table — register + migrate |
| `AccessTokenRepository` | Repository<AccessToken> with `createToken` / `findByPlaintext` / `revokeAllForUser` |
| `authMiddleware` / `guestMiddleware` | Functions returned by the registered `auth` / `guest` middleware factories |
| `AUTH_BUILTIN_NAMES` | String-key constants used in `config.http.middleware` and `route.middleware('...')` |
| `AuthProvider` | ServiceProvider that binds Hasher + AuthManager and auto-wires `ctx.auth` |
| `assertAuth(ctx)` | Helper that narrows `ctx.auth` to a non-null `AuthContext` |

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/setup.md`](./guides/setup.md) — wiring AuthProvider, building a custom guard, the `config.auth` shape, the `ctx.auth` lifecycle.
- [`guides/middleware.md`](./guides/middleware.md) — `auth` / `guest` middleware (with the `:guardName` factory form), error responses, ordering.
- [`guides/sessions.md`](./guides/sessions.md) — SessionGuard / Session schema + migration, what's deferred (sliding-window expiry, payload column, session rotation, cleanup command), production checklist.
- [`guides/tokens.md`](./guides/tokens.md) — TokenGuard / AccessToken schema + migration, token format, minting and verifying, what's deferred (abilities/scopes, `last_used_at`), production checklist.
