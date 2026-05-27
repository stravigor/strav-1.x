# @strav/kernel

Foundation of the Strav framework. Ships the IoC container, the service-provider lifecycle, configuration, the event bus, helpers, encryption, storage, cache, i18n, logger, and the session abstraction.

> **Status: 1.0.0-alpha — M1 in progress.**
> Currently implemented: **Container** + `@inject()` decorator.
> Up next: `ServiceProvider`, `Application`, `EventBus`, `ConfigRepository`, `Logger`, helpers.

## Install

```bash
bun add @strav/kernel
```

## Minimal example

```ts
import { Container, inject } from '@strav/kernel'

@inject()
class Logger {
  info(msg: string) { console.log('[info]', msg) }
}

@inject()
class UserService {
  constructor(private log: Logger) {}
  greet(name: string) { this.log.info(`hello ${name}`) }
}

const app = new Container().singleton(Logger)
app.make(UserService).greet('world')
// [info] hello world
```

## What's here

| Symbol | Purpose |
|---|---|
| `Container` | IoC container with `register` / `singleton` / `scoped` / `bind` / `tag` / `when` |
| `@inject()` | Class decorator marking constructor-injectable classes |
| `isInjectable` | Runtime check for the marker |
| `getParamTypes` | Read constructor param types via `reflect-metadata` |

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

More guides land as the kernel grows.
