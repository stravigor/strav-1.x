# @strav/auth

Authentication primitives for Strav 1.0 — `Hasher` (argon2id), guards, the per-request `ctx.auth` façade, and `auth` / `guest` middleware.

> **Status: 1.0.0-alpha — M2 in progress (foundation slice).**
> Shipping: **Hasher** (Bun.password / argon2id), **Authenticatable** contract, **Guard** + **AuthManager** + **AuthContext** (`ctx.auth`), **MemoryGuard** (dev/test), **auth / guest middleware**, **AuthProvider** (auto-wires the lot + `ctx.auth` context enricher).
> Deferred (need `@strav/database`): real **SessionGuard**, opaque-**TokenGuard**, **magic links**, **email verification**, **TOTP** (small but lives with the full auth flows). **JWT** driver opt-in: post-1.0. The `MemoryGuard` is a placeholder for tests + dev — production apps will swap it for SessionGuard / TokenGuard when those land.

## Install

```bash
bun add @strav/auth
```

Peer deps: `@strav/kernel`, `@strav/http` (both already in the workspace).

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
| `authMiddleware` / `guestMiddleware` | Functions returned by the registered `auth` / `guest` middleware factories |
| `AUTH_BUILTIN_NAMES` | String-key constants used in `config.http.middleware` and `route.middleware('...')` |
| `AuthProvider` | ServiceProvider that binds Hasher + AuthManager and auto-wires `ctx.auth` |
| `assertAuth(ctx)` | Helper that narrows `ctx.auth` to a non-null `AuthContext` |

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/setup.md`](./guides/setup.md) — wiring AuthProvider, building a custom guard, the `config.auth` shape, the `ctx.auth` lifecycle.
- [`guides/middleware.md`](./guides/middleware.md) — `auth` / `guest` middleware (with the `:guardName` factory form), error responses, ordering.
