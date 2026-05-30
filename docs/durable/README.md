# @strav/durable

Crash-resumable workflows for Strav 1.0 on top of `@strav/queue` and Postgres. A workflow run survives process restarts: each node is its own crash boundary, completed nodes are journaled by name (replays skip what's already done), failures retry with backoff, and exhausted retries trigger reverse-order saga compensation.

> **Status: 1.0.0-alpha.** Full builder surface:
> - **`.step(name, handler, opts?)`** — sequential, retried, optionally saga-compensated.
> - **`.sleep(name, delay)`** — park the run for N seconds (or a context-aware deadline).
> - **`.waitForSignal(name, signalName)`** — pause until `runner.signal(runId, name, payload?)` fires; payload becomes the node's result.
> - **`.parallel(name, branches)`** — fan-out via `Promise.all`; whole-or-nothing failure.
> - **`.route(name, select, branches)`** — pick one of N branches by predicate.
> - **`.loop(name, condition, body)`** — repeat while `condition()` holds; each iteration is its own journal row keyed `<name>#<i>`.
> - **`.childWorkflow(name, start)`** — spawn another registered workflow and wait for it via parent-side polling.
>
> Plus the engine: **`DurableRunner`** (`start` / `advance` / `signal` / `compensate` / `find`), **`DurableAdvanceJob`** + **`DurableCompensateJob`** queue Jobs, **`DurableProvider`** service provider, **`strav_workflow_runs`** + **`strav_workflow_journal`** schemas, **per-node retries** (default 3 attempts, exponential backoff capped at 60s), **saga compensation** (reverse-order over completed-journal entries), **typed errors** (`DurableError`, `RunNotFoundError`, `WorkflowNotRegisteredError`).
>
> Deferred: status state machine via `@strav/machine`, `durable:status` / `durable:cancel` console commands, per-attempt journaling (V1 only journals terminal node outcomes), per-branch compensators on `.parallel` (only `.step` carries `compensate?` today).

## Install

```bash
bun add @strav/durable
```

Peer deps: `@strav/kernel`, `@strav/database`, `@strav/queue`. Apps also need a concrete `Queue` driver bound in the container (`DatabaseQueue` in production, `SyncQueue` in tests).

## Minimal example

```ts
// app/workflows/onboard_workflow.ts
import { defineDurable } from '@strav/durable'

export const onboardWorkflow = defineDurable('user:onboard', (w) =>
  w
    .step('createAccount', async (ctx) => {
      const userId = await userRepo.create({ email: ctx.input.email as string })
      return { userId }
    })
    .step('sendWelcomeEmail', async (ctx) => {
      await mail.send(new WelcomeMail((ctx.results.createAccount as { userId: string }).userId))
      return { sent: true }
    }, {
      compensate: async (ctx) => {
        await userRepo.delete((ctx.results.createAccount as { userId: string }).userId)
      },
    })
    .step('subscribeToPlan', async (ctx) => {
      const subId = await billing.subscribe((ctx.results.createAccount as { userId: string }).userId)
      return { subId }
    }, {
      compensate: async (ctx) => {
        await billing.cancel((ctx.results.subscribeToPlan as { subId: string }).subId)
      },
    }),
)
```

```ts
// app/providers/workflows_provider.ts — register on boot
import { ServiceProvider } from '@strav/kernel'
import { WorkflowRegistry } from '@strav/durable'
import { onboardWorkflow } from '../workflows/onboard_workflow.ts'

export class WorkflowsProvider extends ServiceProvider {
  override readonly name = 'workflows'
  override readonly dependencies = ['durable']

  override boot(app: Application): void {
    app.resolve(WorkflowRegistry).register(onboardWorkflow)
  }
}
```

```ts
// app/http/controllers/onboard_controller.ts — start a run
import { inject } from '@strav/kernel'
import { DurableRunner } from '@strav/durable'

@inject()
export class OnboardController {
  constructor(private readonly durable: DurableRunner) {}

  async store(ctx: HttpContext): Promise<Response> {
    const runId = await this.durable.start('user:onboard', { email: ctx.request.body.email })
    return ctx.response.accepted({ runId })
  }

  async show(ctx: HttpContext): Promise<Response> {
    const snapshot = await this.durable.find(ctx.request.params.runId)
    return ctx.response.ok(snapshot)
  }
}
```

The first `runner.start()` returns immediately. Workers pick up the `durable.advance` jobs, walk every step in order, and journal each result. If `subscribeToPlan` exhausts its retries, the runner enqueues a `durable.compensate` job; the worker walks back through the journal and runs `subscribeToPlan` and `sendWelcomeEmail`'s compensators in reverse (most-recent-first).

## V2 node types

Every node lives in the same flat builder; the runner switches on `type` to know how to drive it. Each node still occupies one slot in the integer cursor — sub-state lives in `state` JSONB so no schema migration is required.

```ts
defineDurable('checkout', (w) =>
  w
    .parallel('verifyAndPrice', {
      verify:  async (ctx) => fraud.check(ctx.input.cart),
      price:   async (ctx) => pricing.quote(ctx.input.cart),
      stock:   async (ctx) => warehouse.reserve(ctx.input.cart),
    })
    .route(
      'paymentRail',
      (ctx) => (ctx.results.verifyAndPrice as { price: { total: number } }).price.total > 10_000 ? 'wire' : 'card',
      {
        wire: async (ctx) => bank.wireRequest(ctx.input.userId, ctx.results),
        card: async (ctx) => stripe.charge(ctx.input.userId, ctx.results),
      },
    )
    .waitForSignal('riskApproval', 'risk.approve')      // resumed by `runner.signal(runId, 'risk.approve', {...})`
    .sleep('settlementBuffer', 24 * 60 * 60)             // park 24h
    .childWorkflow('fulfillment', async (ctx) => ({
      name: 'fulfillment',
      input: { orderId: (ctx.results.paymentRail as { result: { orderId: string } }).result.orderId },
    }))
    .loop(
      'sendReceipts',
      (_ctx, i) => i < 3,                                // retry up to 3 times
      async (ctx) => mail.send(new ReceiptMail(ctx.input.userId, ctx.iteration)),
    ),
)
```

External resume for `waitForSignal`:

```ts
// HTTP handler on POST /webhooks/risk
await durable.signal(runId, 'risk.approve', { decision: 'approve', officer: 'risk.bot' })
```

The signal payload becomes `ctx.results.riskApproval` for every later node.

## What's here

| Symbol | Purpose |
|---|---|
| `DurableWorkflow` | Builder. `.step` / `.sleep` / `.waitForSignal` / `.parallel` / `.route` / `.loop` / `.childWorkflow`. Every node is journaled by name — duplicates throw at registration |
| `defineDurable(name, fn)` | Sugar over `new DurableWorkflow(name)` matching `defineSchema` / `defineMachine` / `defineWorkflow` |
| `WorkflowRegistry` | Name → workflow lookup. Apps register workflows on it; the runner uses it to resolve workflows when advancing a run |
| `DurableRunner` | Engine. `start(name, input) → runId`, `find(runId) → snapshot`, `advance(runId)` (job handler), `compensate(runId)` (job handler), `signal(runId, signalName, payload?)` to wake a `waitForSignal` node |
| `DurableAdvanceJob` / `DurableCompensateJob` | Queue Jobs that delegate to the runner. Both use `maxAttempts = 1` — retry semantics live inside the runner |
| `DurableProvider` | ServiceProvider. Binds runner + registry, registers schemas with `SchemaRegistry`, eager-resolves at boot |
| `workflowRunsSchema` / `workflowJournalSchema` | The two tables. Runs hold the durable record + in-flight retry counters; journal is the per-step idempotency log |
| `JOURNAL_UNIQUE_INDEX` | Name of the composite UNIQUE the provider provisions on `(run_id, step_name)` — belt-and-suspenders against duplicate journal writes |
| `RunSnapshot` / `RunStatus` | The shape `runner.find` returns. `RunStatus` is `pending` / `running` / `waiting` / `compensating` / `completed` / `failed` |
| `DurableContext` | What handlers receive: `{ input, results, runId, attempt }` |
| `DurableError` / `RunNotFoundError` / `WorkflowNotRegisteredError` | Typed `StravError`s |

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/lifecycle.md`](./guides/lifecycle.md) — the full run lifecycle: start → advance → journal → retry → compensate → terminal. Failure modes, where retries kick in, what gets journaled when.
- [`guides/handlers.md`](./guides/handlers.md) — writing step handlers: idempotency, what `ctx.attempt` means, why handlers can't close over request-scoped state, when to dispatch a Job vs do the work inline.

## When NOT to use `@strav/durable`

- **One-shot in-process orchestrations.** Reach for `@strav/workflow` — same `.step()` shape, no queue dependency, no DB writes, runs to completion in the caller's process.
- **State machines.** If you're modeling "this entity is in state X and can transition to Y," that's a `@strav/machine`. Workflows are one-shot; machines are ongoing.
- **Long-lived agents.** Workflows execute step-by-step against a fixed plan. If the model decides what to do next, you want `@strav/brain`'s agent layer (which lands when it ships) wrapped in a workflow only when you need crash-resumable persistence of the agent loop.
- **Single-step async work.** A durable workflow with one `.step()` adds DB tables, a queue dispatch, and a row lock vs. a plain `await job.dispatch(...)`. Use the queue directly.
