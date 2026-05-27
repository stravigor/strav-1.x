# Service providers — patterns and recipes

Service providers are the only legal place to bind services and to run boot/shutdown work for a subsystem. This guide shows the patterns you'll use most.

## Anatomy

```ts
import { Application, ServiceProvider } from '@strav/kernel'

class AuthProvider extends ServiceProvider {
  readonly name = 'auth'
  readonly dependencies = ['database', 'config']

  register(app: Application): void {
    app.singleton(Auth)
  }

  async boot(app: Application): Promise<void> {
    const auth = app.resolve(Auth)
    auth.useResolver((id) => app.make(UserRepository).find(id))
    await auth.ensureTables()
  }

  async shutdown(app: Application): Promise<void> {
    await app.resolve(Auth).stopReapingTimer()
  }
}
```

Four parts:

| Part | Role |
|---|---|
| `name` (abstract) | Unique identifier used for dependency resolution |
| `dependencies` | Names of providers that must boot first; default `[]` |
| `register(app)` | Synchronous binding pass; runs before any provider's `boot()` |
| `boot(app)` | Async setup; runs in dep order after every `register()` finished |
| `shutdown(app)` | Reverse-order cleanup on SIGINT/SIGTERM/`app.shutdown()` |

## What can go where

| Hook | Allowed | Not allowed |
|---|---|---|
| `register(app)` | `app.singleton(...)`, `app.bind(...)`, `app.tag(...)`, `app.when(...)` | `app.resolve(...)` — other providers may not have registered yet |
| `boot(app)` | Resolve any service, open connections, register event listeners, start timers, query the DB | Adding new providers (the app is already booted) |
| `shutdown(app)` | Close connections, flush buffers, stop timers, persist last state | Adding new bindings (the container is being disposed) |

## Declaring dependencies

Providers declare boot-order dependencies by **name**:

```ts
class HttpProvider extends ServiceProvider {
  readonly name = 'http'
  readonly dependencies = ['config', 'logger', 'session']
}
```

The Application's Kahn topo-sort:

- Throws on a **duplicate name**.
- Throws on an **unknown name** in `dependencies`.
- Throws on a **cycle**.

Listing too few dependencies leads to "service X is not registered" at boot. Listing too many costs nothing but creates a more constrained order.

## Where providers live

| Provider | Lives in |
|---|---|
| Framework provider (Database, Http, Mail, …) | `@strav/<package>/providers/<name>_provider.ts` |
| App-level provider | `app/providers/<name>_provider.ts` |

All providers are listed in `bootstrap/providers.ts`. The order of the array is the registration order for providers without dependency hints; `dependencies = [...]` overrides it.

## Writing an app provider

App providers are small. The container auto-makes controllers, repositories, FormRequests, and policies, so you only register what truly needs explicit binding:

- App-wide singletons.
- Interface → concrete bindings.
- Tagged collections.
- Event-listener subscriptions (in `boot()`).
- Policy-to-resource mappings.

```ts
// app/providers/app_provider.ts
import { ServiceProvider, type Application } from '@strav/kernel'

export class AppProvider extends ServiceProvider {
  readonly name = 'app'
  readonly dependencies = ['database']

  register(app: Application): void {
    // App-wide singletons
    app.singleton(LeadScorer)

    // Tagged collections (resolved with app.tagged('reporters'))
    app.tag([SlackReporter, EmailReporter, SentryReporter], 'reporters')
  }

  async boot(app: Application): Promise<void> {
    // Event-listener subscriptions go in boot, not register
    app.events.on('lead.qualified', async (lead) => {
      await app.make(LeadScorer).rescore(lead)
    })
  }
}
```

## Provider configuration

Providers may take constructor arguments:

```ts
new AuthProvider({ guard: 'web', sessionTable: 'sessions' })
new HttpProvider({ port: 3000, host: '0.0.0.0' })
```

Or read from `ConfigRepository` (lands in M1.8):

```ts
class HttpProvider extends ServiceProvider {
  readonly name = 'http'
  readonly dependencies = ['config']

  register(app: Application): void {
    const config = app.resolve<ConfigRepository>('config').section<HttpConfig>('http')
    app.singleton('http.config', () => config)
    app.singleton(HttpKernel)
  }
}
```

Convention: providers prefer reading config via the bound `'config'` service over taking constructor args. Constructor args are useful for one-shot tweaks (e.g., a test override).

## Patterns

### "Ensure table" pattern

For subsystems that own DB tables (sessions, jobs, audit):

```ts
async boot(app: Application): Promise<void> {
  await app.resolve(Database).ensureTable(sessionTableSchema)
}
```

Idempotent: the SQL is `CREATE TABLE IF NOT EXISTS`. Convenient in development; in production the table is owned by a migration.

### "useResolver" pattern

For services that need to call back into user code (e.g., auth resolving a User):

```ts
async boot(app: Application): Promise<void> {
  const auth = app.resolve(Auth)
  auth.useResolver(async (id) => app.make(UserRepository).find(id))
}
```

This decouples the framework service from the user's model.

### "useTransport" pattern

For services with pluggable backends (mail driver, cache store):

```ts
register(app: Application): void {
  app.singleton('mail.transport', (c) => {
    const config = c.resolve<ConfigRepository>('config').section<MailConfig>('mail')
    switch (config.transport) {
      case 'smtp':   return new SmtpTransport(config.smtp)
      case 'resend': return new ResendTransport(config.resend)
      default:       throw new ConfigError({ code: 'mail.unknown-transport' })
    }
  })
}
```

## Boot rollback

If any provider's `boot()` throws, the application **rolls back**:

1. Every already-booted provider's `shutdown()` runs in reverse order.
2. The original error re-throws.
3. The app is left in an un-booted state. No kernel runs.

You don't write rollback logic — the Application orchestrates it. Just make sure your `shutdown()` is safe to call even when `boot()` only partially succeeded.

## Testing providers

A provider is a class — test it like any class.

```ts
test('AuthProvider registers Auth', () => {
  const app = new Application()
  new ConfigProvider().register(app)
  new AuthProvider().register(app)
  expect(app.has(Auth)).toBe(true)
})
```

For integration, use a real Application:

```ts
test('AuthProvider boots cleanly', async () => {
  const app = new Application()
    .useProviders([new ConfigProvider(), new AuthProvider()])
  await app.start({ signalHandlers: false })
  expect(app.resolve(Auth)).toBeInstanceOf(Auth)
  await app.shutdown()
})
```

The `signalHandlers: false` flag prevents the test from installing real SIGINT/SIGTERM handlers in the test process.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Service "x" is not registered` during a provider's `register()` | You tried to `resolve()` inside `register()` | Move to `boot()` |
| `Application: provider "x" depends on "y", which is not registered.` | Dependency name typo, or `y` missing from the provider list | Verify the name; ensure the provider is in `useProviders([...])` |
| Provider `boot()` runs in the wrong order | Implicit ordering relied on array position | Add explicit `dependencies = ['...']` |
| Shutdown hangs | A timer or connection isn't cleaned up | Clear it in `shutdown()`; the 30s hard timeout will eventually force-exit |
| Provider works locally but not in tests | Test app's `providers` array is missing it | Add the provider to the test app factory |
