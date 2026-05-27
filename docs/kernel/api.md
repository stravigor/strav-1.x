# @strav/kernel — API Reference

This page lists every public export of `@strav/kernel` with signature, semantics, and a minimal example.

> **Status:** Reflects what's implemented as of M1.7 — `Container`, `@inject()`, `ServiceProvider`, `Application`, and a minimal `EventBus`.
> `ConfigRepository`, full `EventBus` (parallel + cancelable), `Logger`, helpers, and the various subsystems will appear here as they land.

## `Application`

`Application` extends `Container`. It adds provider orchestration: topological sort, register / boot / shutdown lifecycle, signal handlers, lifecycle events, and runtime-environment helpers.

```ts
import { Application, ServiceProvider } from '@strav/kernel'

const app = new Application().useProviders([
  new ConfigProvider(),
  new LoggerProvider(),
  new DatabaseProvider(),
])

await app.start()
```

### `use(provider)` / `useProviders(providers)`

Register one or many providers. Must be called **before** `start()`. After the app boots, both throw.

```ts
app.use(new ConfigProvider())
app.useProviders([new LoggerProvider(), new DatabaseProvider()])
```

### `start({ signalHandlers? })`

Boot the application. Returns a Promise that resolves once every provider's `boot()` has finished.

Sequence:

1. Emit `app:starting`.
2. Topologically sort providers by `dependencies`.
3. Call every provider's `register(app)` (sync).
4. Call every provider's `boot(app)` (async, in order).
5. Install SIGINT / SIGTERM handlers (unless `signalHandlers: false`).
6. Emit `app:booted`.

On a `boot()` failure, the framework rolls back: every already-booted provider's `shutdown()` is called in reverse order, then the original error re-throws.

Calling `start()` after the app is already booted is a no-op.

### `shutdown()`

Gracefully shut down. Calls every booted provider's `shutdown()` in **reverse boot order**. A 30-second hard timeout force-exits if a provider hangs. Per-provider errors are logged but do not stop the loop.

After shutdown the container's instance cache is disposed (`dispose()`), signal handlers are removed, and `isBooted` returns `false`.

Lifecycle events emitted: `app:shutdown` (before), `app:terminated` (after).

Calling `shutdown()` twice is a no-op.

### `onBooted(callback)`

Shorthand for `app.events.once('app:booted', callback)`. Returns `this` for chaining.

```ts
new Application()
  .useProviders([...])
  .onBooted(() => log.info('ready'))
  .start()
```

### `events: EventBus`

Per-application event bus. Same lifetime as the app. Used internally for lifecycle events (`app:starting`, `app:booted`, `app:shutdown`, `app:terminated`) and available to user code.

```ts
app.events.on('app:booted', () => log.info('ready'))
app.events.emit('user.created', user)
```

### `isBooted` / `isShuttingDown`

Read-only state.

```ts
app.isBooted        // true after start() resolves
app.isShuttingDown  // true while shutdown() is in progress
```

### Environment helpers

```ts
app.env()                   // 'local' | 'testing' | 'staging' | 'production'
app.env('production')       // boolean — is the current env this one?
app.isProduction()
app.isLocal()
app.isTesting()
app.isStaging()
```

Reads `APP_ENV`. Defaults to `'production'` when unset (safe default).

> When `ConfigRepository` lands in M1.8, these delegate to the config so caching artifacts pick up the right value at boot time.

### `StartOptions`

```ts
interface StartOptions {
  signalHandlers?: boolean   // default true; pass false to manage signals yourself
}
```

### `AppEnv`

```ts
type AppEnv = 'local' | 'testing' | 'staging' | 'production'
```

## `ServiceProvider`

Abstract base class. A provider is the only legal place to bind services and to run boot/shutdown work for a subsystem.

```ts
import { Application, ServiceProvider } from '@strav/kernel'

class DatabaseProvider extends ServiceProvider {
  readonly name = 'database'
  readonly dependencies = ['config', 'logger']

  register(app: Application): void {
    app.singleton(Database, (c) => new Database(c.resolve('config')))
  }

  async boot(app: Application): Promise<void> {
    await app.resolve(Database).connect()
  }

  async shutdown(app: Application): Promise<void> {
    await app.resolve(Database).disconnect()
  }
}
```

### `name: string` (abstract)

Unique provider name used by the topo-sort. Two providers with the same name → boot throws.

### `dependencies: readonly string[]`

Names of providers that must register and boot before this one. Defaults to `[]`. Unknown names → boot throws.

### `register(app)`

Synchronous binding pass. Runs before any provider's `boot()`. **Do not call `app.resolve(...)` here** — other providers may not have registered yet.

### `boot(app)`

Async initialization. Runs in dependency order after every provider's `register()` finished. Safe to resolve other services here, open connections, subscribe to events, etc.

### `shutdown(app)`

Async cleanup. Runs in reverse boot order on SIGINT / SIGTERM / `app.shutdown()`. Each provider gets up to its share of the 30-second total shutdown budget.

## `EventBus`

Per-application event dispatcher (M1.7 surface). Sequential dispatch, FIFO order, errors propagate.

> M1.9 extends this with `emitParallel`, batch `subscribe`, wildcards, and the cancelable-vs-non-cancelable contract. The M1.7 surface below is the minimum the Application needs.

```ts
app.events.on('user.created', async (user) => {
  await mailer.send(new WelcomeEmail(user))
})
```

### `on<P>(name, fn)` → `Unsubscribe`

Register a listener. Returns a function that removes the listener.

```ts
const off = app.events.on('user.created', listener)
off()  // remove
```

### `once<P>(name, fn)` → `Unsubscribe`

Same as `on` but fires at most once. The listener is removed from the dispatch list **before** its handler runs, so re-entrant emits don't re-trigger it.

### `emit<P>(name, payload?)` → `Promise<void>`

Dispatch `payload` to every registered listener, sequentially in registration order, awaiting async listeners. Resolves after the last listener returns.

If a listener throws, the error propagates from `emit` and remaining listeners do not run. (M1.9 will refine this with the cancelable contract.)

### `removeAllListeners(name?)`

Remove listeners for one event name (with `name`) or all events (without).

### `listenerCount(name)`

Diagnostic. Returns the number of listeners registered for `name`.

### `Listener<P>`

```ts
type Listener<P = unknown> = (payload: P, name?: string) => void | Promise<void>
```

The second argument is the event name — useful for listeners attached to multiple events (M1.9 batch subscribe).

## `Container`

The IoC container. Bind services, resolve them, auto-construct classes via `@inject()`.

```ts
import { Container, inject } from '@strav/kernel'

const app = new Container()
```

### `register<T>(key, factory?)`

Bind a **factory** — new instance per resolve.

```ts
// Class as key, auto-constructed via @inject()
@inject() class Logger {}
app.register(Logger)

// Class with custom factory
app.register(Logger, () => new Logger())

// String key with factory
app.register('clock', () => new Date())

// String key with class
app.register('logger', Logger)
```

### `singleton<T>(key, factory?)`

Bind a **singleton** — same instance on every resolve. Cached at the container where the binding lives, so all child scopes share it.

```ts
@inject() class Database {}
app.singleton(Database)

app.singleton('cache', () => new MemoryCache())
```

### `scoped<T>(key, factory?)`

Bind a **scoped singleton** — one instance per scope. Each scope created via `createScope()` gets its own instance on first resolve, cached locally.

```ts
@inject() class RequestContext {}
app.scoped(RequestContext)

const reqA = app.createScope().resolve(RequestContext)
const reqB = app.createScope().resolve(RequestContext)
// reqA !== reqB
```

### `bind<T>(interfaceKey, ConcreteClass)`

Sugar for an interface → concrete singleton binding. The concrete is auto-constructed via `@inject()`.

```ts
app.bind('cache', RedisCache)
const cache = app.resolve<RedisCache>('cache')
```

### `tag(classes, name)`

Tag a group of classes under a name; retrieve them with `tagged(name)`.

```ts
@inject() class SlackReporter implements Reporter {}
@inject() class EmailReporter implements Reporter {}

app.tag([SlackReporter, EmailReporter], 'reporters')

const all = app.tagged<Reporter>('reporters')
for (const r of all) await r.send(event)
```

### `when(Consumer).needs(Dep).give(Impl)`

**Contextual binding.** Override which class is injected for a specific consumer.

```ts
app.when(BillingController).needs(Cache).give(RedisCache)
app.when(LeadController).needs(Cache).give(PostgresCache)
```

`give(impl)` accepts either a class (auto-constructed) or a `Factory<T>` callable.

### `resolve<T>(key)`

**Strict** lookup. Returns the bound instance or throws if the key is not registered.

```ts
const log = app.resolve(Logger)
const cache = app.resolve<Cache>('cache')

// Throws "Container: service Foo is not registered."
app.resolve(SomeUnboundClass)
```

### `make<T>(Class)`

**Permissive** construction. If the class is bound, behaves like `resolve(Class)`. If not, reads constructor param types via `@inject()` metadata, recursively resolves each, and `new Class(...deps)`.

```ts
@inject() class A {}
@inject() class B { constructor(public a: A) {} }

const b = app.make(B)
// B is constructed, A is auto-injected.
// No singleton(A) needed.
```

This is what the framework uses internally to construct controllers, FormRequests, policies — anything `@inject()`-decorated that doesn't need shared state across requests.

### `has(key)`

`true` if the key is bound on this container or any parent in the scope chain.

```ts
app.has(Logger)        // true
app.has('cache')       // true if bound
app.has(SomeOther)     // false
```

### `tagged<T>(name)`

Return an array of instances for every class tagged under `name`. Walks the scope chain.

```ts
const reporters = app.tagged<Reporter>('reporters')
```

### `createScope()`

Returns a child container. Parent bindings are inherited; the scope has its own instance cache. Use this in HTTP/queue/console kernels to isolate request/job/command state.

```ts
const scope = app.createScope()

// scope-local override of a parent binding
scope.singleton(Foo, () => new Foo('per-scope'))

// scoped bindings instantiate per-scope
app.scoped(RequestContext)
scope.resolve(RequestContext) // unique to this scope
```

### `dispose()`

Discard this container's cached singleton/scoped instances. The container is still usable (factories remain), but the cache is gone. Kernels call this after each request/job/command.

```ts
scope.dispose()
```

## `@inject()`

Class decorator. Marks a class as constructor-injectable.

```ts
import { inject } from '@strav/kernel'

@inject()
class UserService {
  constructor(private db: Database, private cache: Cache) {}
}
```

Required for **any** class with constructor params that you want to resolve through `make()`. Without `@inject()`, TypeScript emits no metadata, so `make()` can't see the param types and throws a clear error.

### Limitations

**No circular class refs in constructor params.** If class `A` lists class `B` as a constructor param and `B` is declared after `A` in the same module, the `@inject()` call on `A` hits JavaScript's temporal dead zone and throws `ReferenceError: Cannot access 'B' before initialization`.

Restructure: extract a common abstraction, or move shared state into a dedicated service. The framework does not ship a workaround.

**Param types must be classes.** TypeScript only emits `design:paramtypes` for class types. Interfaces, type aliases, and primitives (`string`, `number`, `boolean`) come through as `String`/`Number`/`Boolean` constructors, which the container won't know what to do with. For string/number/boolean deps, use a string-keyed binding and resolve manually in a factory.

## `isInjectable(cls)`

Runtime check for the `@inject()` marker. Returns `boolean`.

```ts
import { isInjectable } from '@strav/kernel'

if (isInjectable(SomeClass)) {
  // ...
}
```

## `getParamTypes(cls)`

Read the constructor param types of an `@inject()`-marked class. Returns `Constructor[]` (empty if no params).

```ts
import { getParamTypes } from '@strav/kernel'

const params = getParamTypes(UserService)
// → [Database, Cache]
```

## `INJECTABLE`

The symbol attached to `@inject()`-decorated classes. Useful only for framework code; consumers use `isInjectable`.

```ts
const INJECTABLE: unique symbol
```

## Types

```ts
type Constructor<T = unknown> = new (...args: any[]) => T

type Factory<T> = (c: Container) => T

type Key<T = unknown> = string | Constructor<T>

type BindingKind = 'factory' | 'singleton' | 'scoped'

interface Binding<T = unknown> {
  factory: Factory<T>
  kind: BindingKind
}

type Unsubscribe = () => void
```
