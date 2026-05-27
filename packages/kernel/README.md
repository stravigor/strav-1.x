# @strav/kernel

Foundation of the Strav framework: IoC container, service-provider lifecycle, configuration, event bus, helpers, encryption, storage, cache, i18n, logger, session abstraction.

**Status: 1.0.0-alpha — M1 implementation in progress.**

## Install

```bash
bun add @strav/kernel
```

## What's here

- `Container` — register / singleton / resolve / make / bind / when / tag — auto-DI via `@inject()`.
- `Application` — provider topo-sort, boot, shutdown, signal handlers.
- `ServiceProvider` — `register`, `boot`, `shutdown` lifecycle.
- `ConfigRepository` — typed config keyed by dotted path; frozen after boot.
- `EventBus` — `emit`/`emitParallel`/`on`/`once`/`subscribe` with cancelable contract.
- `StravError` hierarchy.
- `Logger` — Pino-backed.
- `helpers/` — env, ULID, crypto, clock.

## Subpath imports (cross-package strav use only)

The public API lives at the root barrel. Sub-paths exist so other `@strav/*` packages can import the subsystem they need without circular barrel chains:

```ts
import { Application } from '@strav/kernel/core'
import { EventBus }    from '@strav/kernel/events'
```

Consumer apps should always import from the root barrel:

```ts
import { Application, EventBus, ServiceProvider } from '@strav/kernel'
```

## Docs

- [`spec/architecture.md`](../../spec/architecture.md) — container + provider contracts.
- [`spec/lifecycles.md`](../../spec/lifecycles.md) — boot / shutdown sequence.
- [`guides/05-service-container.md`](../../guides/05-service-container.md)
- [`guides/06-service-providers.md`](../../guides/06-service-providers.md)
- [`guides/04-application-lifecycle.md`](../../guides/04-application-lifecycle.md)
