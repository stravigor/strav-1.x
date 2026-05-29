# Writing durable step handlers

A step handler in `@strav/durable` looks like a plain async function but the runtime makes much stronger demands than a synchronous request handler. This guide covers what those demands are and how to satisfy them.

## The handler signature

```ts
async (ctx: DurableContext) => Promise<unknown>
```

Where:

```ts
interface DurableContext {
  readonly input: Record<string, unknown>
  readonly results: Record<string, unknown>
  readonly runId: string
  readonly attempt: number
}
```

That's the whole interface. No DB connection, no Repository, no logger — just the run's input, the prior steps' results, an attempt counter, and an id you can use for log correlation.

If your handler needs anything else, that "anything else" must be resolvable at execution time from **module scope** (an exported repository singleton, an imported queue, a global config). It can't come from the request that started the run.

## Why no DI

The `DurableAdvanceJob` IS injected — its constructor takes `DurableRunner` via the container. But the *step handlers* are functions registered on a `DurableWorkflow` builder, and the builder is constructed once at module load. By the time a worker picks up the `advance` job, the request that started the run is long gone; the container scope for that request is gone too.

```ts
// ❌ This doesn't work. `userRepo` is a request-scoped binding from
// the controller; it's not available when the worker picks up the job.
function makeWorkflow(userRepo: UserRepository) {
  return defineDurable('demo', (w) =>
    w.step('create', async (ctx) => {
      return userRepo.create({ email: ctx.input.email as string })
    }),
  )
}

// ✅ This works. The handler resolves UserRepository through a
// container reference available at module scope.
import { userRepository } from '../repositories/index.ts'

export const demoWorkflow = defineDurable('demo', (w) =>
  w.step('create', async (ctx) => {
    return userRepository.create({ email: ctx.input.email as string })
  }),
)
```

The shape of "module-scope-resolvable" is up to the app. Two common patterns:

**Application singleton.** Export the live `Application` from a module and resolve services off it in the handler:

```ts
import { app } from '../bootstrap/app.ts'

export const onboardWorkflow = defineDurable('user:onboard', (w) =>
  w.step('create', async (ctx) => {
    const users = app.resolve(UserRepository)
    return users.create({ email: ctx.input.email as string })
  }),
)
```

**Lazy container reference.** A small helper that returns a service on demand. Cleaner when you have many services and don't want each handler reaching into `app`:

```ts
import { resolve } from './bootstrap/container.ts'

w.step('create', async (ctx) => {
  const users = resolve(UserRepository)
  return users.create({ ... })
})
```

Either way, the handler depends on framework-level state, not request-level state.

## What `ctx.input` and `ctx.results` carry

Both are plain objects that round-trip through `JSON.stringify` — anything you put into them at `runner.start(name, input)` or returned from a prior step has to be JSON-serializable. No Dates (they become strings), no `Map`s, no class instances, no `undefined` values.

If you need a Date downstream, convert in the handler:

```ts
w.step('expiresAt', async (ctx) => {
  const ms = (ctx.results.charge as { expiresAt: string }).expiresAt
  return { expiresAt: new Date(ms).toISOString() }
})
```

If you need to pass a Model through several steps, store its id and re-`find` it where you need it. The handler can do its own DB read.

## `ctx.attempt` — what to do on retry

The runtime gives you a 1-based attempt counter. Most handlers ignore it; some adjust behavior:

```ts
w.step('flaky_api_call', async (ctx) => {
  // First attempt: full timeout. Second: tighter. Third: tightest.
  const timeoutMs = ctx.attempt === 1 ? 30_000 : ctx.attempt === 2 ? 15_000 : 5_000
  return apiClient.call(ctx.input.payload, { timeoutMs })
}, { maxAttempts: 3 })
```

A common pattern is to log retry-vs-first-try differently:

```ts
w.step('send_email', async (ctx) => {
  const logger = resolve(LogManager).channel('durable')
  if (ctx.attempt > 1) {
    logger.warn('retrying mail send', { runId: ctx.runId, attempt: ctx.attempt })
  }
  return mail.send(...)
})
```

Compensators always see `attempt: 1` — they don't have a retry counter. If a compensator needs idempotency tracking, use a column on the entity it's rolling back.

## Idempotency is your responsibility

The runner's journal makes sure a *committed* step doesn't re-run. But a step that crashes mid-execution **will** re-run on the next delivery:

```
worker picks up advance(runId)
  → SELECT FOR UPDATE the run row
  → run the handler — let's say it sends an HTTP POST and the worker crashes
  → transaction rolls back (no journal write)
queue redelivers advance(runId)
  → SELECT FOR UPDATE the run row
  → no journal entry exists for this step → run the handler AGAIN
  → HTTP POST happens twice
```

The runner can't protect external side effects. Your handler has to be idempotent on its own:

| External thing | Idempotency mechanism |
|---|---|
| Stripe charges | Stripe idempotency key (`Idempotency-Key` header, you generate from `runId + stepName`) |
| Internal INSERT | `INSERT ... ON CONFLICT DO NOTHING` keyed on `runId + stepName` |
| External webhook delivery | Use the queue with its own idempotency key — `queue.dispatch(WebhookJob, { uniqueKey: runId + stepName, ... })` |
| Cross-system update | A natural unique key (order id, transaction id) + an `IF NOT EXISTS` check before the update |

The standard ULID generator is fine for these keys — combine `ctx.runId + ctx.stepName` (you can extract the step name from your handler's enclosing scope) for a stable per-step-per-run identifier.

Compensators need to be idempotent too. They may run zero, one, or two times:

- **Zero** — if the process dies after the journal failed-row write but before the compensate job runs.
- **One** — the happy path.
- **Two** — if a compensator commits successfully but the runner's transaction (which includes "mark this run failed") rolls back due to a DB hiccup. The runner retries the whole compensate; the compensator runs again.

A refund-already-refunded charge should be a no-op. A delete-already-deleted row should be a no-op. Et cetera.

## Side-effect placement

Where the side effect lives matters:

| Pattern | Behavior |
|---|---|
| HTTP POST + DB update in one step | Retry re-runs both. Need idempotency on the POST. |
| HTTP POST in step A; DB update in step B | A retries independently of B; B is guaranteed to see A's result once A is journaled completed. Use this when A's idempotency cost is high. |
| Dispatch a Job from a step that doesn't await it | The Job runs whenever the worker picks it up. **The Job will fire even if the durable run fails afterwards.** Use this only when the side effect is meant to happen unconditionally. |
| Dispatch a Job from inside `UnitOfWork.run(...)` (i.e. the runner's own transaction) | The dispatch commits with the journal — the Job won't fire if the journal write fails. Same queue-until-commit semantics as `Repository.create` events. |

In practice, most "send email after this step" patterns are best implemented as dispatching a Job that's idempotent (it does its own DB check before sending). The durable workflow's role is to record the *intent*; the Job's role is to deliver it.

## Compensators

Same shape as step handlers — async function over `DurableContext`. The return is ignored.

```ts
w.step('reserve', async (ctx) => {
  return { reservation_id: await inventory.reserve(ctx.input.sku) }
}, {
  compensate: async (ctx) => {
    const reservationId = (ctx.results.reserve as { reservation_id: string }).reservation_id
    await inventory.release(reservationId)
  },
})
```

Compensators run **after** the run was marked `compensating` — by definition, the work they're rolling back was *committed* (it has a journal row). Apps don't need to second-guess whether the reservation exists; the journal row says it does.

If the reservation might have been double-committed (the original step ran twice due to a redelivery), the compensator should still be idempotent. `inventory.release(id)` on an already-released id should be a no-op.

## When to skip durable

Durable is overkill for:

- **Single-step work.** If your whole "workflow" is one async step, dispatch a `Job` directly. Durable adds two tables + a row lock for nothing.
- **Pure in-process orchestration.** Use `@strav/workflow`. Same `.step()` shape, no DB, no queue.
- **External orchestration that doesn't need restart resilience.** If your only requirement is "this multi-step thing should succeed eventually, and we'll fix it if it doesn't," a Job that does the steps inline + retries on Job-level failure is simpler than a durable workflow.

The durable cost is real: two table writes per step, a transactional dispatch, queue depth, and the complexity overhead of writing idempotent handlers. Reach for it when one or more of "the process can die mid-run," "we need atomic compensation across failed steps," or "the run must be polled from a UI" is genuinely load-bearing.
