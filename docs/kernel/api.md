# @strav/kernel — API Reference

This page lists every public export of `@strav/kernel` with signature, semantics, and a minimal example.

> **Status:** Reflects what's implemented as of M1.9 — `Container`, `@inject()`, `ServiceProvider`, `Application`, full `EventBus` (parallel, cancelable, wildcards, batch), `ConfigRepository`, `ConfigProvider`, and the `env()` helper.
> `Logger`, more helpers, `StravError` hierarchy, `ConsoleKernel`, and the remaining subsystems will appear here as they land.

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

Per-application event dispatcher. Implements the full multi-listener contract from `spec/lifecycles.md`: sequential dispatch (`emit`), parallel dispatch (`emitParallel`), the cancelable-vs-non-cancelable error contract, wildcards (`*`, `prefix.*`), batch registration, and three listener shapes (function / class with `handle()` / instance with `handle()`).

```ts
app.events.on('user.created', async (user) => {
  await mailer.send(new WelcomeEmail(user))
})
```

### `on(name, listener)` → `Unsubscribe`

Register a listener. Returns a function that removes the listener.

```ts
const off = app.events.on('user.created', listener)
off()
```

The listener can be:

- A plain function: `(payload, name?) => void | Promise<void>`
- A class with `handle()`: `@inject() class HandleUserCreated { handle(p) { ... } }` — the framework constructs it via the container on each dispatch
- An object with `handle()`: `{ handle(p) { ... } }` — used as a singleton listener

### Batch registration

Four shapes — all return one `Unsubscribe` that removes every registration made by the call:

```ts
app.events.on('user.created', [listener1, listener2])
app.events.on(['user.created', 'user.updated'], listener)
app.events.on(['e1', 'e2'], [a, b])           // cross-product

app.events.subscribe({
  'user.created':   [sendWelcomeEmail, logAudit],
  'user.deleted':   cleanupAccount,
  'user.*':         logUserEvent,
})
```

### `once(name, listener)` → `Unsubscribe`

Fires at most once. The listener is removed from the dispatch list **before** its handler runs, so re-entrant emits don't re-trigger it.

### `emit(name, payload?)` → `Promise<void>`

Dispatch to every matching listener **sequentially** in registration order, awaiting async listeners.

Error contract:

- **Non-cancelable event**: a listener throw is caught and reported via the `onListenerError` handler (default `console.error`). Remaining listeners still run. `emit` resolves.
- **Cancelable event**: the first listener throw rejects `emit`, subsequent listeners do **not** run.

Default cancelable predicate matches the repository lifecycle gates: `*.creating`, `*.updating`, `*.deleting`, `*.restoring`. Override via `EventBusOptions.isCancelable`.

### `emitParallel(name, payload?)` → `Promise<void>`

Dispatch concurrently — `Promise.allSettled`-style.

- **Forbidden on cancelable events.** Throws synchronously: cancellation requires sequential ordering.
- Partial failure: errors reported via `onListenerError`, `emit` resolves.
- Total failure (every listener failed): throws an `AggregateError` carrying every individual error.

### Wildcards

| Pattern | Matches |
|---|---|
| `*` | Every event |
| `prefix.*` | `prefix.<one segment>` (e.g., `user.*` matches `user.created` but NOT `user.profile.updated`) |
| exact name | Only that exact name |

Wildcards interleave with specific listeners in registration order — there is one ordered dispatch list, not two.

```ts
app.events.on('user.*', (_, name) => log.info('user event', { name }))
app.events.on('*',       (_, name) => metrics.increment('events.total'))
```

### `removeAllListeners(name?)`

Remove every listener for an exact pattern (with `name`) or every listener everywhere (without).

### `listenerCount(pattern)`

Diagnostic. Returns the number of listeners registered under an exact pattern. Wildcard listeners registered under `user.*` are counted there, not under `user.created`.

### `setErrorHandler(fn)`

Replace the error handler used for non-cancelable listener throws. The Application wires its `ExceptionHandler` here when M1.10 lands.

### `EventBusOptions`

```ts
interface EventBusOptions {
  resolver?:        <T>(Class: Constructor<T>) => T
  isCancelable?:    (name: string) => boolean
  onListenerError?: (error: unknown, eventName: string) => void
}
```

The `Application` constructs `app.events` with a resolver bound to `app.make`, so class listeners are auto-constructed via the container on each dispatch.

### Listener types

```ts
type Listener<P = unknown> = (payload: P, name?: string) => void | Promise<void>

type ListenerClass<P = unknown> = new (...args: any[]) => ListenerInstance<P>

interface ListenerInstance<P = unknown> {
  handle(payload: P, name?: string): void | Promise<void>
}

type AnyListener<P = unknown> = Listener<P> | ListenerClass<P> | ListenerInstance<P>
```

## `ConfigRepository`

Typed key-value store keyed by dotted path. Built from `config/*.ts` files, frozen after `app:booted`.

```ts
import { ConfigRepository } from '@strav/kernel'

const config = app.resolve(ConfigRepository)
// or
const config = app.resolve<ConfigRepository>('config')
```

### `get(key)` / `get(key, default)`

Read a value by dotted path. Returns `defaultValue` (or `undefined`) when the path is missing. Falsy values (`0`, `''`, `false`) are returned as-is, not replaced.

```ts
config.get<string>('app.name')                       // string | undefined
config.get<string>('app.name', 'fallback')           // string
config.get<number>('database.pool.max', 10)
```

### `has(key)`

`true` if the dotted path resolves to a value (other than `undefined`).

### `section<T>(key)`

Read a typed sub-tree. Throws if the section is missing — use this when a section is required.

```ts
const db = config.section<DbConfig>('database')
db.host  // typed
```

### `set(key, value)` / `merge(entries)`

Write a value by dotted path. Intermediate path segments are created as needed. Throws after `freeze()` has been called.

```ts
config.set('cache.default', 'redis')
config.merge({ 'app.name': 'test', 'db.host': '127.0.0.1' })
```

Use only during boot — once the app has fully booted, the repository is frozen.

### `all()`

Returns a deep-cloned snapshot of the entire config. Mutating the snapshot has no effect on the repository.

### `freeze()` / `isFrozen()`

Lock the repository. After `freeze()`, `set()` and `merge()` throw. The `ConfigProvider` calls this automatically when `app:booted` fires.

### `ConfigData`

```ts
type ConfigData = Record<string, unknown>
```

The shape of the data the repository wraps. Each top-level key typically corresponds to a `config/<name>.ts` file's default export.

## `ConfigProvider`

Binds `ConfigRepository` and arranges the freeze-on-`app:booted` contract.

```ts
import { ConfigProvider } from '@strav/kernel'

// In bootstrap/providers.ts
import appConfig from '../config/app.ts'
import dbConfig from '../config/database.ts'

export default [
  new ConfigProvider({ app: appConfig, database: dbConfig }),
  // ... other providers
]
```

`ConfigProvider` has no dependencies (`name = 'config'`, `dependencies = []`), so it registers first. Other providers can `c.resolve<ConfigRepository>('config')` in their `register()` and `boot()` methods.

In `boot()`, `ConfigProvider` registers a `once('app:booted', ...)` listener that calls `config.freeze()`. Because it boots first, its listener is the first to fire when `app:booted` is emitted — so any user-registered listener sees the frozen config.

## `env`

Read environment variables with typed coercion + safe defaults. **Use only in `config/*.ts` files.**

```ts
import { env } from '@strav/kernel'

export default {
  name:     env('APP_NAME', 'my-app'),
  port:     env.int('PORT', 3000),
  debug:    env.bool('DEBUG', false),
  trusted:  env.list('TRUSTED_IPS'),
  key:      env.required('APP_KEY'),
}
```

### `env(name)` / `env(name, default)`

String. Returns `process.env[name]` or `defaultValue` if unset or empty.

```ts
env('APP_NAME')                  // string | undefined
env('APP_NAME', 'my-app')        // string
```

### `env.int(name)` / `env.int(name, default)`

Integer. Throws if the value is set but not a valid integer (e.g., `"3.14"` or `"abc"`).

```ts
env.int('PORT', 3000)
env.int('TIMEOUT')               // number | undefined
```

### `env.bool(name)` / `env.bool(name, default)`

Boolean. Recognises (case-insensitive): `1`, `true`, `yes`, `on`, `y` → `true`; `0`, `false`, `no`, `off`, `n`, `""` → `false`. Anything else throws.

```ts
env.bool('DEBUG', false)
```

### `env.list(name)` / `env.list(name, default)`

String array. Splits on comma, trims each item, drops empties.

```ts
env.list('CORS_ORIGINS', ['*'])  // ['*'] or ['https://a.com', 'https://b.com']
```

### `env.required(name)`

Throws `Error` if the env var is unset or empty. Returns a guaranteed `string`.

```ts
env.required('APP_KEY')          // string (or throws)
```

### `EnvFn`

```ts
type EnvFn = typeof env
```

## `Clock`

Test-friendly "now" abstraction. Inject `Clock` instead of calling `Date.now()`.

```ts
interface Clock {
  now(): Date          // current time as Date
  millis(): number     // ms since epoch
  iso(): string        // ISO-8601 string
}
```

### `SystemClock`

Real wall-clock implementation. The production binding.

```ts
class SystemClock implements Clock
```

### `FrozenClock`

Manually-controlled clock for tests. Defaults to "now" if no argument is given.

```ts
class FrozenClock implements Clock {
  constructor(time?: number | Date)
  set(time: number | Date): void   // replace the frozen time
  advance(ms: number): void        // move forward (or back, with negative)
}
```

```ts
const clock = new FrozenClock('2026-01-01T00:00:00Z')
clock.advance(60 * 1000)
clock.iso() // '2026-01-01T00:01:00.000Z'
```

`now()` returns a fresh `Date` per call — callers can mutate it without affecting the clock.

## Crypto helpers

Thin wrappers over `node:crypto`. Used for random tokens, fingerprints, signed values, constant-time comparisons. Password hashing (bcrypt/argon2) belongs in `@strav/auth`, not here.

### `randomBytes(byteLength?)`

```ts
function randomBytes(byteLength?: number): Buffer
```

Cryptographically-strong random bytes. Defaults to 32. Throws `TypeError` if `byteLength` isn't a positive integer.

### `randomToken(byteLength?)`

```ts
function randomToken(byteLength?: number): string
```

Random URL-safe base64url token. Default 32 random bytes → 43-character string. Use for opaque session/CSRF/API tokens.

### `sha256(input)`

```ts
function sha256(input: string | Uint8Array): string
```

SHA-256 hex digest.

### `hmacSha256(key, input)`

```ts
function hmacSha256(key: string | Uint8Array, input: string | Uint8Array): string
```

HMAC-SHA256 hex digest. Use to sign cookies, derive subkeys, fingerprint with a secret.

### `constantTimeEqual(a, b)`

```ts
function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean
```

Constant-time equality. Returns `false` for length mismatch without comparing bytes. **Always use this to compare secrets** — `===` leaks timing info.

Note on strings: compares **byte length**, not character length (UTF-8 byte count). `constantTimeEqual('é', 'e')` returns `false`.

### `randomUUID()`

```ts
function randomUUID(): string
```

UUID v4. Re-export of `node:crypto`'s `randomUUID`.

## ULID

```ts
function ulid(timestamp?: number): string
function isUlid(value: unknown): value is string
function decodeUlidTime(value: string): number
```

Universally-unique Lexicographically-sortable IDentifier. 26-character Crockford-Base32 — 10 chars of millisecond timestamp + 16 chars of randomness. Sortable as a string by creation time.

### `ulid(timestamp?)`

Default: current `Date.now()`. Pass a timestamp to override (useful with `FrozenClock` in tests).

Guarantees within this generator:
- **Monotonic within a millisecond**: successive calls with the same timestamp produce strictly-greater outputs (the random portion is incremented, not re-randomized).
- **Sortable across milliseconds**: a later timestamp produces a lexicographically-greater ULID.

Throws:
- `TypeError` if timestamp is negative, `NaN`, or infinite.
- `RangeError` if timestamp exceeds 48 bits (year 10889).
- `Error` if monotonic overflow occurs within one millisecond (would require generating 2⁸⁰ IDs in 1 ms — won't happen).

### `isUlid(value)`

Type-guard. `true` iff `value` is a 26-character string containing only allowed Crockford characters (lenient — `I`/`L` → `1`, `O` → `0`, lowercase accepted).

### `decodeUlidTime(value)`

Returns the embedded timestamp in milliseconds since epoch. Throws `TypeError` on malformed input.

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

## `ConsoleKernel`

Transport-layer kernel for command-line entry points. Builds on top of `Application`. See the [console guide](./guides/console.md) for usage; this section is the type/signature reference.

```ts
class ConsoleKernel {
  readonly app: Application

  constructor(app: Application, output?: ConsoleOutput)

  /** Register one or more command classes. Returns this. */
  register(...Classes: CommandClass[]): this

  /** All registered command classes (for introspection / tests). */
  commands(): readonly CommandClass[]

  /** Dispatch one argv and return the exit code. Assumes app.isBooted. */
  handle(argv: readonly string[]): Promise<number>

  /** Convenience entry: build (or accept) an app, boot, dispatch, shutdown. */
  static run(options: ConsoleRunOptions): Promise<number>
}
```

### `ConsoleRunOptions`

```ts
interface ConsoleRunOptions {
  argv: readonly string[]
  app?: Application                   // pre-built; otherwise kernel constructs one
  providers?: readonly ServiceProvider[]
  commands?: readonly CommandClass[]
  signalHandlers?: boolean            // default false for console
  output?: ConsoleOutputOptions
}
```

`run`:
1. Uses `options.app` if provided; otherwise constructs a fresh `Application`.
2. Registers `providers` (if any) via `app.useProviders`.
3. Constructs a `ConsoleKernel` and registers `commands`.
4. If the app isn't already booted, calls `app.start({ signalHandlers })`.
5. Dispatches `argv` via `handle`.
6. Shuts the app down — even on exception — when `run` started it.

Returns the exit code. Caller decides whether to `process.exit`.

### Special argv handled by `handle`

| `argv[0]` | Behaviour |
|---|---|
| `undefined` (empty argv) | Print list, return 0 |
| `'list'` | Print list, return 0 |
| `'--help'` / `'-h'` | Print list, return 0 |
| unknown command | Error to stderr, return 1 |

## `Command` (abstract)

```ts
abstract class Command {
  abstract handle(ctx: CommandContext): CommandResult
}

type CommandResult = Promise<number | void> | number | void
```

Subclasses must declare two static fields that the kernel reads at registration time **without instantiating the class**:

```ts
class HelloCommand extends Command {
  static readonly signature = 'hello'                 // command name
  static readonly description = 'Print a greeting'
  async handle(ctx: CommandContext): Promise<void> {
    ctx.out.line('hi')
  }
}
```

### `CommandClass`

```ts
type CommandClass<T extends Command = Command> = Constructor<T> & {
  readonly signature: string
  readonly description: string
}
```

### `CommandContext`

```ts
interface CommandContext {
  readonly args: readonly string[]
  readonly flags: Readonly<Record<string, string | boolean>>
  readonly out: ConsoleOutput
  readonly app: Application
}
```

## `ConsoleOutput`

Minimal ANSI output writer.

```ts
class ConsoleOutput {
  constructor(options?: ConsoleOutputOptions)
  line(msg?: string): void          // stdout + '\n', never colored
  info(msg: string): void           // blue, stdout
  success(msg: string): void        // green, stdout
  warn(msg: string): void           // yellow, stdout
  error(msg: string): void          // red, stderr
  write(msg: string): void          // raw stdout
  writeError(msg: string): void     // raw stderr
}

interface ConsoleOutputOptions {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  useColor?: boolean                // default: stdout.isTTY
}
```

Pass `useColor: false` in tests for plain-text assertions, or `useColor: true` to assert escape sequences.

## `parseArgv`

```ts
function parseArgv(argv: readonly string[]): ParsedArgv

interface ParsedArgv {
  command: string | undefined        // first non-flag token, if any
  args: string[]                     // positional after the command
  flags: Record<string, string | boolean>
}
```

Recognized forms:

| Token | Effect |
|---|---|
| `--flag` | `{ flag: true }` |
| `--flag=value` | `{ flag: 'value' }` |
| `--flag value` | `{ flag: 'value' }` (next token consumed iff it doesn't start with `-`) |
| `-f` | `{ f: true }` |
| `--` | Ends flag parsing |
| anything else | First → `command`; rest → `args` |

Caveat: `--flag value` form swallows the next token. Put flags after the command, or use `--flag=value`.

## Exceptions

The error hierarchy every Strav kernel and package raises from. See the [errors guide](./guides/errors.md) for usage patterns; this section is the type/signature reference.

### `StravError` (abstract)

```ts
abstract class StravError extends Error {
  readonly code: string
  readonly status: number
  readonly context: Readonly<Record<string, unknown>>
  // inherited from Error: message, name, cause, stack

  protected constructor(
    message: string,
    defaults: { code: string; status: number },
    options?: StravErrorOptions,
  )

  toJSON(): ErrorJSON
}
```

The protected constructor enforces "instantiate a subclass, never `StravError` itself". Each subclass passes its own `defaults`.

### `StravErrorOptions`

```ts
interface StravErrorOptions {
  /** Override the default code for this subclass. */
  code?: string
  /** Structured payload — copied into a frozen object. */
  context?: Record<string, unknown>
  /** Underlying cause (mirrors standard Error.cause). */
  cause?: unknown
}
```

### `ErrorJSON`

```ts
interface ErrorJSON {
  name: string
  code: string
  status: number
  message: string
  context?: Record<string, unknown>  // omitted when empty
}
```

`cause` and `stack` are never serialized.

### Subclasses

Each is constructed as `new SubClass(message?, options?)`. Default messages are listed below; pass any string to override.

```ts
class ValidationError    extends StravError  // 422 — 'validation-error'
class AuthError          extends StravError  // 401 — 'auth-error'
class AuthorizationError extends StravError  // 403 — 'authorization-error'
class NotFoundError      extends StravError  // 404 — 'not-found'
class ConflictError      extends StravError  // 409 — 'conflict'
class RateLimitError     extends StravError  // 429 — 'rate-limited'
class ConfigError        extends StravError  // 500 — 'config-error'  (no default message)
class ServerError        extends StravError  // 500 — 'server-error'
```

Default messages:

| Class | Default `message` |
|---|---|
| `ValidationError` | `Validation failed.` |
| `AuthError` | `Authentication required.` |
| `AuthorizationError` | `You are not authorized to perform this action.` |
| `NotFoundError` | `Resource not found.` |
| `ConflictError` | `Resource conflict.` |
| `RateLimitError` | `Too many requests.` |
| `ServerError` | `Internal server error.` |
| `ConfigError` | _(message is required — no default)_ |

### `ValidationError` (specifics)

```ts
class ValidationError extends StravError {
  readonly errors: Readonly<Record<string, readonly string[]>>
  constructor(message?: string, options?: ValidationErrorOptions)
  override toJSON(): ValidationErrorJSON
}

interface ValidationErrorOptions extends StravErrorOptions {
  errors?: Record<string, readonly string[]>
}

interface ValidationErrorJSON extends ErrorJSON {
  errors: Record<string, readonly string[]>
}
```

The `errors` map and each field's array are frozen at construction. `toJSON()` always includes `errors` (even when empty `{}`).

### `RateLimitError` (specifics)

```ts
class RateLimitError extends StravError {
  readonly retryAfter: number | undefined
  constructor(message?: string, options?: RateLimitErrorOptions)
  override toJSON(): RateLimitErrorJSON
}

interface RateLimitErrorOptions extends StravErrorOptions {
  retryAfter?: number  // seconds; surfaced as Retry-After header
}

interface RateLimitErrorJSON extends ErrorJSON {
  retryAfter?: number
}
```

`retryAfter` is included in `toJSON()` only when defined.

### `isStravError(err): err is StravError`

```ts
function isStravError(err: unknown): err is StravError
```

Type-guard. `true` iff `err` is an instance of any `StravError` subclass.

### `asStravError(err, fallbackMessage?): StravError`

```ts
function asStravError(err: unknown, fallbackMessage?: string): StravError
```

Normalize any throwable into a `StravError`:

- If `err` is a `StravError` already → returned unchanged.
- Else if `err` is an `Error` → wrapped in `ServerError` (message carried through, original preserved as `cause`).
- Else → wrapped in `ServerError` with `fallbackMessage` (default: `'Internal server error.'`); `cause` is the raw value.

Used by kernel exception handlers to guarantee a `code` / `status` / `toJSON()`-shaped error before reporting or rendering.
