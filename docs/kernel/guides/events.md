# Events — patterns and recipes

Events let one part of the app react to something that happened in another part, without the two parts importing each other. Strav's `EventBus` is per-application: `app.events`.

## The multi-listener contract

| Aspect | Behaviour |
|---|---|
| Order | Registration FIFO across the whole bus (wildcards interleave with specific listeners) |
| Execution (`emit`) | Sequential; awaits each listener |
| Execution (`emitParallel`) | Concurrent (`Promise.allSettled`) |
| Errors on non-cancelable events | Caught, reported via `onListenerError`, remaining listeners run |
| Errors on cancelable events | First throw rejects `emit`, chain stops |
| Cancelable events (default) | `*.creating`, `*.updating`, `*.deleting`, `*.restoring` |
| `emitParallel` on cancelable | Forbidden — throws synchronously |

## Subscribing

```ts
// Single listener
app.events.on('user.created', async (user) => {
  await mailer.send(new WelcomeEmail(user))
})

// Multiple listeners for one event
app.events.on('user.created', [sendWelcomeEmail, startOnboardingFlow, logAudit])

// One listener for multiple events
app.events.on(['user.created', 'user.updated'], async (user) => {
  await search.index(user)
})

// Cross-product
app.events.on(['e1', 'e2'], [a, b])    // 4 registrations

// Subscription map — common in provider boot()
app.events.subscribe({
  'user.created':   [sendWelcomeEmail, logAudit],
  'user.deleted':   cleanupAccount,
  'user.*':         logUserEvent,
})
```

Every form returns one `Unsubscribe` function that removes every registration made by the call.

```ts
const off = app.events.subscribe({ 'user.*': listener })
off()   // removes the user.* listener
```

## Listener shapes

The bus accepts three:

```ts
// 1. Plain function
app.events.on('user.created', (user) => log.info('created', { id: user.id }))

// 2. Class with handle() — auto-made via the container per dispatch
@inject()
class SendWelcomeEmail {
  constructor(private mailer: Mailer) {}
  async handle(user: User) {
    await this.mailer.send(new WelcomeEmail(user))
  }
}
app.events.on('user.created', SendWelcomeEmail)

// 3. Instance with handle() — used as a singleton listener
const auditer = { handle(user: User) { audit.log('user.created', user) } }
app.events.on('user.created', auditer)
```

Class-listener dispatch:

1. The bus calls the resolver — provided by `Application` as `<T>(Class) => this.make(Class)`.
2. `make` runs the @inject() construction: a fresh `SendWelcomeEmail` is built, with `Mailer` resolved from the container.
3. The bus calls `.handle(payload, name)`.

So **a class listener is a fresh instance per dispatch.** Use an instance listener (option 3) if you want a singleton.

## Sequential vs parallel

```ts
// emit — sequential, awaited, total time = sum of listener durations
await app.events.emit('user.created', user)
// Listener 1 runs to completion, then Listener 2, then ...

// emitParallel — concurrent, total time = max of listener durations
await app.events.emitParallel('user.created', user)
// All listeners run in parallel; resolves when every settled
```

Use `emitParallel` for independent fan-out (e.g., notifying many systems of the same event). Stay with `emit` when listeners depend on side effects of earlier ones, or when you need ordering guarantees.

`emitParallel` is **forbidden on cancelable events** — they require sequential ordering to gate. The bus throws synchronously if you try.

## Cancelable events

The repository lifecycle gates — `*.creating`, `*.updating`, `*.deleting`, `*.restoring` — are cancelable by default. A listener that throws rejects `emit`, and the framework treats the throw as a veto.

```ts
app.events.on('user.creating', async (input) => {
  if (await blacklist.has(input.email)) {
    throw new ConflictError('email is blacklisted', { code: 'user.email-blacklisted' })
  }
})

// Now any `users.create(input)` call will reject if the email is blacklisted —
// no row is written.
```

For app-defined cancelable events, override the predicate:

```ts
new EventBus({ isCancelable: (name) => name.startsWith('strict:') })
```

`Application` constructs the bus once with the default predicate. To customise, either replace the bus on `Application` (not recommended in 1.0), or stick with the standard suffix-based gates.

## Error reporting

When a listener throws on a non-cancelable event, the bus calls `onListenerError(error, eventName)`. Default: `console.error`.

You can replace it at any time:

```ts
app.events.setErrorHandler((error, name) => {
  Sentry.captureException(error, { tags: { event: name } })
})
```

When M1.10 lands the `StravError` hierarchy and `ExceptionHandler`, the `Application` will wire its handler in automatically.

## Wildcards

```ts
app.events.on('*',        (_, name) => metrics.increment(`events.${name}`))
app.events.on('user.*',   (user, name) => log.info('user event', { name, id: user.id }))
app.events.on('order.*',  (order) => analytics.track('order_event', order))
```

`*` matches every event; `prefix.*` matches one dot-segment after `prefix.`. Multi-level wildcards are not supported in 1.0.

Wildcards interleave with specific listeners in registration order:

```ts
app.events.on('user.*',       () => order.push('wildcard'))
app.events.on('user.created', () => order.push('specific'))
await app.events.emit('user.created')
// order: ['wildcard', 'specific']
```

## When to use `once`

```ts
app.events.once('app:booted', () => log.info('ready'))
```

`once` removes the listener from the dispatch list **before** its handler runs. Re-entrant emits inside the handler do not re-trigger it.

`Application.onBooted(fn)` is a shorthand for `app.events.once('app:booted', fn)`.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Listener throws and the request fails | Event is cancelable (`*.creating`, etc.) — by design | If the cancel is unwanted, log instead of throw |
| Listener doesn't fire | Pattern mismatch | Check the exact name; remember wildcards are one-segment only |
| Class listener throws "no container resolver configured" | The bus was constructed without a resolver | The framework's `app.events` always has one; you only see this in tests that build a raw `EventBus` |
| `cannot emitParallel on cancelable event` | Tried to dispatch a `.creating`/`.updating`/etc. event in parallel | Use `emit` instead — cancelable events must be sequential |
| `AggregateError` from `emitParallel` | Every listener failed | Inspect `.errors[]`; if listeners actually depend on each other, switch to `emit` |
| Listener added during emit doesn't fire | By design — emit snapshots the listener list before dispatch | Either emit again, or register before the emit |
