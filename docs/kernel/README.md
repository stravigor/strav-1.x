# @strav/kernel

Foundation of the Strav framework. Ships the IoC container, the service-provider lifecycle, configuration, the event bus, helpers, encryption, storage, cache, i18n, logger, and the session abstraction.

> **Status: 1.0.0-alpha.4 — M1 + M2 shipped.**
> Shipping: **Container**, `@inject()`, **ServiceProvider**, **Application**, full **EventBus** (cancelable, parallel, wildcards, batch), **ConfigRepository**, **ConfigProvider**, `env()`, **StravError** hierarchy + `asStravError`, helpers (`Clock`, `ulid`, `randomToken`, `sha256`, `hmacSha256`, `constantTimeEqual`, `randomUUID`), **ConsoleKernel** + `Command` framework, **Logger** + **LogManager** + **LoggerProvider** (Pino-backed; `stack`/`stderr`/`single`/`daily` drivers, deep-glob redaction), **Cipher** + **AesGcm256Cipher** + **EncryptionProvider** (AES-256-GCM, iv||tag||ct, key as hex/base64/Uint8Array), e2e boot smoke at `tests/e2e/m1-boot/`.

## Install

```bash
bun add @strav/kernel
```

## Minimal example

```ts
import { Container, inject } from '@strav/kernel'

@inject()
class Mailer {
  send(to: string, subject: string) { /* … */ }
}

@inject()
class UserService {
  constructor(private mailer: Mailer) {}
  welcome(email: string) { this.mailer.send(email, 'Welcome!') }
}

const app = new Container().singleton(Mailer)
app.make(UserService).welcome('user@example.com')
```

For a full app with `Application` + providers, the typical bootstrap is:

```ts
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'
import loggerConfig from './config/logger.ts'

const app = new Application()
  .useProviders([
    new ConfigProvider({ logger: loggerConfig }),
    new LoggerProvider(),
  ])

await app.start()
```

## What's here

| Symbol | Purpose |
|---|---|
| `Application` | `Container` + provider lifecycle (topo-sort, boot, shutdown, signals, events) |
| `ServiceProvider` | Abstract base for `register` / `boot` / `shutdown` lifecycle |
| `EventBus` | `on` / `once` / `emit` / `emitParallel` / `subscribe`, wildcards, cancelable contract |
| `ConfigRepository` | Typed dotted-path config; frozen after `app:booted` |
| `ConfigProvider` | Binds the repository, arranges the freeze on `app:booted` |
| `env()` | Typed env-var reader for `config/*.ts` files |
| `Clock` / `SystemClock` / `FrozenClock` | "Now" abstraction — inject instead of calling `Date.now()` |
| `ulid` / `isUlid` / `decodeUlidTime` | Lexicographically-sortable IDs (26-char Crockford-Base32) |
| `randomBytes` / `randomToken` / `randomUUID` | Strong random material |
| `sha256` / `hmacSha256` / `constantTimeEqual` | Hashing + safe comparison primitives |
| `ConsoleKernel` | Argv → command dispatch, exit code; `static run({...})` convenience for `bin/strav.ts` |
| `Command` / `CommandContext` / `ConsoleOutput` | The console command framework |
| `parseArgv` | Standalone argv parser (positional + `--flag=val` / `--flag val` / `-f` / `--`) |
| `Logger` | Pino-backed logger: `info`/`warn`/…, `child(ctx)`, `channel(name)`, redaction-before-serialize |
| `LogManager` | Channel registry built from `config.logger`; one logger per channel, lifecycle owner |
| `LoggerProvider` | Binds `Logger` / `LogManager` / `'logger'` alias; fails fast on bad config |
| `compileRedactor` | Stand-alone path-based redactor (`password`, `*.password`, `**.token`); same engine the logger uses |
| `Container` | IoC container with `register` / `singleton` / `scoped` / `bind` / `tag` / `when` |
| `@inject()` | Class decorator marking constructor-injectable classes |
| `isInjectable` | Runtime check for the marker |
| `getParamTypes` | Read constructor param types via `reflect-metadata` |
| `StravError` + subclasses | Typed error hierarchy: `ValidationError` (422), `AuthError` (401), `AuthorizationError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429), `ConfigError` / `ServerError` (500) |
| `isStravError` / `asStravError` | Type-guard + coercion helper for unknowns at kernel boundaries |

## Sub-path imports

The public API lives at the root barrel. Sub-paths exist so other `@strav/*` packages can import the subsystem they need without circular barrel chains:

```ts
import { Container } from '@strav/kernel/core'
```

Consumer apps should always import from the root barrel:

```ts
import { Container } from '@strav/kernel'
```

## Documentation

- [`api.md`](./api.md) — every public export, signature, semantics.
- [`guides/container.md`](./guides/container.md) — binding patterns, scopes, contextual + tagged bindings, common pitfalls.
- [`guides/providers.md`](./guides/providers.md) — provider lifecycle, dependency ordering, boot rollback, common patterns.
- [`guides/configuration.md`](./guides/configuration.md) — config files, env helpers, freeze contract, type-safe sections.
- [`guides/events.md`](./guides/events.md) — multi-listener contract, sequential vs parallel, cancelable events, wildcards, batch registration, listener shapes.
- [`guides/errors.md`](./guides/errors.md) — the `StravError` hierarchy, custom codes, `asStravError`, `toJSON` serialization, when not to use a typed error.
- [`guides/helpers.md`](./guides/helpers.md) — `Clock` (test-friendly "now"), ULID generation, crypto primitives (random tokens, hashing, constant-time compare).
- [`guides/console.md`](./guides/console.md) — Command anatomy, `ConsoleKernel.run`, argv parsing, output writers, DI in commands, long-running command patterns, test recipes.
- [`guides/logger.md`](./guides/logger.md) — channels (`stack` / `stderr` / `single` / `daily`), levels, structured fields, child loggers, redaction (with deep `**` globs), lifecycle.
- [`guides/encryption.md`](./guides/encryption.md) — `Cipher` + `AesGcm256Cipher` + `EncryptionProvider`. Key formats, storage layout, tamper detection, edge cases, what's deferred (rotation, per-tenant keys, async ciphers).

More guides land as the kernel grows.
