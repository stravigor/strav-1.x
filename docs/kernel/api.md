# @strav/kernel — API Reference

This page lists every public export of `@strav/kernel` with signature, semantics, and a minimal example.

> **Status:** Reflects what's implemented as of M1.6 — `Container` and `@inject()`.
> `Application`, `ServiceProvider`, `EventBus`, `ConfigRepository`, `Logger`, helpers, and the various subsystems will appear here as they land.

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
