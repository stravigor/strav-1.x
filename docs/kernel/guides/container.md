# Container — patterns and recipes

The container is the heart of dependency injection. This guide shows the patterns you'll use most.

## Three binding kinds

| Kind | Use when | Cache scope |
|---|---|---|
| `register` (factory) | A fresh instance every resolve | Never cached |
| `singleton` | Shared instance for the whole app | Cached at the binding's container; inherited by scopes |
| `scoped` | One instance per request/job/command | Cached at the resolving scope, not the parent |

```ts
import { Container, inject } from '@strav/kernel'

@inject() class Clock {}
@inject() class Database {}
@inject() class RequestContext {}

const app = new Container()
app.register(Clock)        // factory — fresh each time
app.singleton(Database)    // one Database for the whole app
app.scoped(RequestContext) // one RequestContext per scope
```

## Auto-construction (`make`) vs strict lookup (`resolve`)

`resolve(key)` is strict: if the key isn't bound, it throws. Good for code that depends on a specific bound service.

`make(Class)` is permissive: if the class is bound, it uses the binding; if not, it auto-constructs via `@inject()`. The framework uses `make` for everything in `app/` — controllers, FormRequests, policies, repositories — so you don't have to register them.

```ts
@inject() class Repo {}
@inject() class Controller {
  constructor(public repo: Repo) {}
}

// No registration needed for either class.
const ctrl = app.make(Controller)
// → app.make(Controller)
// → reads param types: [Repo]
// → recursively make(Repo)
// → new Repo()
// → new Controller(repo)
```

If you want a shared `Repo` across requests, bind it as a singleton:

```ts
app.singleton(Repo)
// Now make(Controller) injects the same Repo every time.
```

## When to register, when not to

**Don't register**:

- Controllers, FormRequests, policies, repositories — `make()` constructs them on demand.
- Mailables and notifications — instantiated by user code with `new`.
- Any plain `@inject()` class that the container can auto-construct.

**Do register**:

- App-wide singletons (DB pool, cache store, mail transport — framework providers do this; you usually don't touch them).
- Interface → concrete bindings: `app.bind('Cache', RedisCache)`.
- Custom factories: when `new Class(...deps)` isn't enough.
- Tagged collections: `app.tag([A, B], 'reporters')`.
- Contextual overrides: `app.when(X).needs(Y).give(Z)`.

## Interface → concrete binding

The container has no notion of TypeScript interfaces at runtime (they're erased), so use a **string key** as the interface name:

```ts
abstract class Cache {
  abstract get<T>(key: string): T | null
  abstract put(key: string, value: unknown, ttl?: string): void
}

@inject() class RedisCache extends Cache { /* ... */ }
@inject() class MemoryCache extends Cache { /* ... */ }

app.bind('cache', RedisCache)
// Anywhere a 'cache' is requested, the user gets a RedisCache.
```

Consumers reach for the string key:

```ts
@inject()
class UserService {
  // ↓ string-keyed dep can't go through @inject() — use a factory
}

app.singleton(UserService, (c) => new UserService(c.resolve<Cache>('cache')))
```

For class-typed deps, prefer `abstract class` so it works as both a type and a runtime key:

```ts
app.bind(Cache, RedisCache)  // Cache is the abstract class
@inject()
class UserService {
  constructor(public cache: Cache) {} // works — Cache is a real value
}
```

## Tagged bindings

When multiple implementations of a contract should all run, tag them and resolve the tag:

```ts
@inject() class SlackReporter implements Reporter {}
@inject() class EmailReporter implements Reporter {}
@inject() class SentryReporter implements Reporter {}

app.tag([SlackReporter, EmailReporter, SentryReporter], 'reporters')

const all = app.tagged<Reporter>('reporters')
for (const r of all) await r.send(event)
```

Tagging works through the scope chain — tags registered on the parent are visible from scopes.

## Contextual binding — `when().needs().give()`

When two consumers need the same abstraction with different concrete implementations:

```ts
abstract class Cache { /* ... */ }
@inject() class RedisCache extends Cache {}
@inject() class PostgresCache extends Cache {}

@inject()
class BillingController {
  constructor(public cache: Cache) {}
}
@inject()
class LeadController {
  constructor(public cache: Cache) {}
}

app
  .when(BillingController).needs(Cache).give(RedisCache)
  .when(LeadController).needs(Cache).give(PostgresCache)

app.make(BillingController).cache  // RedisCache instance
app.make(LeadController).cache     // PostgresCache instance
```

`give(impl)` accepts a class (auto-constructed) or a `Factory<T>` callable for custom construction:

```ts
app.when(Ctrl).needs(Cache).give((c) => new SpecialCache({ region: 'eu' }))
```

## Scopes

A scope is a child container with its own instance cache. The HTTP kernel creates one per request, the queue kernel one per job, the console kernel one per command. Use scopes to isolate request-shaped state.

```ts
const scope = app.createScope()

// Bindings on the parent are inherited
scope.resolve(Database)  // same Database as app.resolve(Database) — singleton shared

// Scope-local bindings shadow the parent
scope.singleton(Database, () => new TestDatabase())
scope.resolve(Database)  // → TestDatabase (only inside this scope)

// Scoped bindings instantiate per-scope
app.scoped(RequestContext)
scope.resolve(RequestContext)  // unique to this scope
```

After the request/job/command finishes, the kernel calls `scope.dispose()` to clear cached instances.

## Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `Container: service X is not registered.` | Calling `resolve(X)` on an unbound key | Use `make(X)` if it's a class, or register the binding |
| `cannot make X — not marked with @inject()` | Class has constructor params but no `@inject()` decorator | Add `@inject()` above the class |
| Constructor dep is `undefined` | TS decorator metadata disabled | Confirm `experimentalDecorators` + `emitDecoratorMetadata` in `tsconfig.json` |
| `ReferenceError: Cannot access 'B' before initialization` at module load | Circular class refs in constructor params | Restructure — extract a common abstraction |
| Scoped singleton seems to be shared across scopes | Bound as `singleton`, not `scoped` | Use `app.scoped(...)` |
| Singleton seems to reset between tests | Test recreated the container without re-binding | Build a shared test app factory; see [Testing guide](../testing/guides/test-app.md) (lands in M4) |
