# @strav/durable

Crash-resumable workflows for Strav 1.0 — sequential `.step()` execution on top of `@strav/queue` and Postgres. A workflow run survives process restarts: each step is its own crash boundary, completed steps are journaled by name (replays skip what's already done), failures retry with backoff, and exhausted retries trigger reverse-order saga compensation.

> **Status: 1.0.0-alpha.11 — M5 slice 4 (durable foundation).**
> Shipping: **`DurableWorkflow`** builder (sequential `.step()` with `compensate? + maxAttempts? + backoff?`), **`defineDurable(name, fn)`** factory, **`WorkflowRegistry`** name → workflow lookup, **`DurableRunner`** engine (start / find / advance / compensate) — each `advance` runs inside one DB transaction with `SELECT FOR UPDATE` on the run row, **`DurableAdvanceJob`** + **`DurableCompensateJob`** queue Jobs that delegate to the runner, **`DurableProvider`** service provider (binds runner + workflow registry, registers schemas with `SchemaRegistry`, eager-resolves at boot), **`strav_workflow_runs`** + **`strav_workflow_journal`** schemas, **per-step retries** (default 3 attempts, exponential backoff capped at 60s), **saga compensation** (reverse-order over completed-journal entries; compensator throws are logged but don't halt the rollback), **typed errors** (`DurableError`, `RunNotFoundError`, `WorkflowNotRegisteredError`).
> Deferred: **`.parallel` / `.route` / `.loop`** (each its own slice — sequential covers most real use cases), **`.sleep(duration)`** (use `queue.dispatchLater` from inside a step today), **`.waitForSignal(name)`** (external resume — needs an HTTP / API surface that lands separately), **`.childWorkflow`** (composable runs), **status state machine via `@strav/machine`** (V1 uses a plain string column; the existing surface already supports machine integration when it lands), **`durable:status` / `durable:cancel` console commands** (waits on a CLI integration slice), **per-attempt journaling** (V1 only journals terminal step outcomes — in-flight retry counters live on the run row).

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

## What's here

| Symbol | Purpose |
|---|---|
| `DurableWorkflow` | Builder. `.step(name, handler, { compensate?, maxAttempts?, backoff? })`. Steps are journaled by name — duplicates throw at registration |
| `defineDurable(name, fn)` | Sugar over `new DurableWorkflow(name)` matching `defineSchema` / `defineMachine` / `defineWorkflow` |
| `WorkflowRegistry` | Name → workflow lookup. Apps register workflows on it; the runner uses it to resolve workflows when advancing a run |
| `DurableRunner` | Engine. `start(name, input) → runId`, `find(runId) → snapshot`, `advance(runId)` (job handler), `compensate(runId)` (job handler) |
| `DurableAdvanceJob` / `DurableCompensateJob` | Queue Jobs that delegate to the runner. Both use `maxAttempts = 1` — retry semantics live inside the runner |
| `DurableProvider` | ServiceProvider. Binds runner + registry, registers schemas with `SchemaRegistry`, eager-resolves at boot |
| `workflowRunsSchema` / `workflowJournalSchema` | The two tables. Runs hold the durable record + in-flight retry counters; journal is the per-step idempotency log |
| `JOURNAL_UNIQUE_INDEX` | Name of the composite UNIQUE the provider provisions on `(run_id, step_name)` — belt-and-suspenders against duplicate journal writes |
| `RunSnapshot` / `RunStatus` | The shape `runner.find` returns. `RunStatus` is `pending` / `running` / `compensating` / `completed` / `failed` |
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
