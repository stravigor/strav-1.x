# @strav/workflow

Workflow orchestration for Strav 1.0 — **sequential / parallel / route / loop** steps with **saga-style compensation**. Pure functions on `@strav/kernel`; no DB, no HTTP, no provider.

> **Status: 1.0.0-alpha.6 — M5 slice 1 (workflow foundation).**
> Shipping: **`Workflow`** typed builder (progressive `Results` widening per step), **`defineWorkflow(name)`** convenience factory, **sequential `.step()`** + per-step compensation, **`.parallel()`** fan-out with per-entry compensation, **`.route()`** conditional dispatch, **`.loop()`** bounded iteration with `until` / `feedback` / `mapInput`, **`Workflow.run(input)`** typed result + `duration`, **`Workflow.plan()`** for introspection, **`WorkflowError`** (`workflow.step-failed`) + **`CompensationError`** (`workflow.compensation-failed`) typed `StravError`s.
> Deferred: **`route` / `loop` compensation** (put cleanup in a regular `step()` for now), **partial-results on failure** (results object today is dropped on throw — the typed payload only ships on success), **AbortSignal threading** (long workflows can't cancel mid-step). **Durable / crash-resumable execution** lands with `@strav/durable` in slice 5.5.

## Install

```bash
bun add @strav/workflow
```

Peer dep: `@strav/kernel`.

## Minimal example

```ts
import { defineWorkflow } from '@strav/workflow'

const processOrder = defineWorkflow<{ orderId: string }>('order:process')
  .step('validate', async (ctx) => {
    return validateOrder(ctx.input.orderId) // → { total: 99 }
  })
  .step('charge', async (ctx) => {
    return chargeCard(ctx.results.validate.total) // typed: number
  }, {
    compensate: async (ctx) => refundCharge(ctx.results.charge.id),
  })
  .step('notify', async (ctx) => {
    return sendConfirmation(ctx.results.charge.id)
  })

const result = await processOrder.run({ orderId: 'o_42' })
result.results.charge.id   // string (typed end-to-end)
result.duration            // ms via performance.now()
```

If `notify` throws, `charge`'s compensator runs (`refundCharge`). `validate` had no compensator so the rollback ends there.

## What's here

| Symbol | Purpose |
|---|---|
| `Workflow<Input, Results>` | The typed builder. Each `.step()` / `.parallel()` / `.route()` / `.loop()` returns `this` widened by the new step's typed return |
| `defineWorkflow<Input>(name)` | Sugar over `new Workflow(name)` — reads as a declaration. Mirrors `defineSchema(...)` in `@strav/database` |
| `WorkflowContext<Input, Results>` | What every handler receives: `{ input, results }`. `results` is typed by what's accumulated up to this step |
| `WorkflowResult<Results>` | What `run()` returns: `{ results, duration }`. `duration` is wall-clock ms |
| `StepHandler` / `LoopHandler` / `RouteResolver` / `Compensator` | Handler types — exported so apps can extract / share handlers in their own modules |
| `StepOptions` / `ParallelEntry` / `LoopOptions` | Per-step option shapes |
| `WorkflowError` | Typed `StravError` (`workflow.step-failed`, status 500) — `context.step` names the failing step, `cause` carries the original throw |
| `CompensationError` | Typed `StravError` (`workflow.compensation-failed`, status 500) — fired when one or more compensators throw during the rollback pass. `context.failures` is the per-compensator breakdown |
| `WorkflowStep` (+ `SequentialStep` / `ParallelStep` / `RouteStep` / `LoopStep`) | Discriminated union of the internal plan. `workflow.plan()` returns this for introspection / tests |

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/sagas.md`](./guides/sagas.md) — the compensation model in depth: when to use it, how rollback ordering works, the parallel-entry edge cases, and how to handle compensator failures.

## When NOT to use a workflow

- **Single-step async work.** A `Workflow` with one `.step()` is just a wrapper around `async () => …`. Reach for the workflow when the orchestration shape matters: multiple steps, branching, rollback.
- **Long-running, crash-resumable work.** This package runs in-process. If the process dies mid-workflow, the run is gone. Use `@strav/durable` (M5 slice 5.5) when you need crash recovery — it persists step state to Postgres and resumes via the queue.
- **State machines.** If you're modeling "this entity can be in state X or Y and transitions are gated", you want `@strav/machine`, not a workflow. Workflows are for one-shot orchestrations; machines are for ongoing state.
