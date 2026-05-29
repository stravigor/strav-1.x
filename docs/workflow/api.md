# @strav/workflow — API Reference

> **Status:** Reflects the workflow foundation slice (M5.1). Pure functions on `@strav/kernel`; no provider, no DB.

## Public exports

```ts
import {
  // The builder + factory
  Workflow,
  defineWorkflow,
  // Context + result shapes
  type WorkflowContext,
  type WorkflowResult,
  // Handler types
  type StepHandler,
  type LoopHandler,
  type RouteResolver,
  type Compensator,
  // Option shapes
  type StepOptions,
  type ParallelEntry,
  type LoopOptions,
  // Errors
  WorkflowError,
  CompensationError,
  type CompensationFailure,
  // Plan introspection (advanced)
  type WorkflowStep,
  type SequentialStep,
  type ParallelStep,
  type RouteStep,
  type LoopStep,
} from '@strav/workflow'
```

## `Workflow<Input, Results>`

The typed builder. Each builder method returns `this` widened by the new step's accumulated `Results`. Apps that don't care about typing can omit generics — the builder still runs untyped via `unknown`.

```ts
class Workflow<Input = unknown, Results extends Record<string, unknown> = {}> {
  readonly name: string

  step<K extends string, R>(
    name: K,
    handler: StepHandler<Input, Results, R>,
    options?: StepOptions<Input, Results>,
  ): Workflow<Input, Results & { [P in K]: R }>

  parallel<Entries extends ReadonlyArray<ParallelEntry<Input, Results, unknown>>>(
    name: string,
    entries: Entries,
  ): Workflow<Input, Results & { [P in Entries[number] as P['name']]: Awaited<ReturnType<P['handler']>> }>

  route<K extends string, Branches extends Record<string, StepHandler<Input, Results, unknown>>>(
    name: K,
    resolver: RouteResolver<Input, Results>,
    branches: Branches,
  ): Workflow<Input, Results & { [P in K]?: Awaited<ReturnType<Branches[keyof Branches]>> }>

  loop<K extends string, IterInput, R>(
    name: K,
    handler: LoopHandler<Input, Results, IterInput, R>,
    options: LoopOptions<Input, Results, IterInput, R>,
  ): Workflow<Input, Results & { [P in K]: R }>

  run(input: Input): Promise<WorkflowResult<Results>>
  plan(): readonly WorkflowStep[]
}
```

### `step(name, handler, options?)`

Append a sequential step. The handler's return type is woven into `Results` under `name`, so the next step's handler sees `ctx.results[name]` typed precisely.

```ts
wf.step('validate', async (ctx) => ({ valid: true, total: 99 }))
  .step('charge',   async (ctx) => ctx.results.validate.total)  // typed: number
```

`options.compensate` registers a saga rollback. If a *later* step throws, this compensator runs in reverse declaration order. See [`guides/sagas.md`](./guides/sagas.md).

### `parallel(name, entries)`

Fan-out via `Promise.all`. Each entry's result is stored under its own `entry.name` — **flat**, not nested under the parallel block's `name`. Apps that want nesting can wrap inside a `.step()`.

```ts
wf.parallel('send', [
  { name: 'email', handler: async (ctx) => sendEmail(ctx) },
  { name: 'sms',   handler: async (ctx) => sendSMS(ctx) },
] as const)
// ctx.results.email and ctx.results.sms are now typed
```

One entry's throw rejects `Promise.all` immediately — in-flight handlers still run to completion, then the workflow aborts. Each entry can declare its own `compensate?: Compensator` (see types below).

### `route(name, resolver, branches)`

Conditional dispatch. `resolver(ctx)` returns a branch key. If the key matches a `branches` entry, that handler runs and its return goes under `name`. **Unknown keys are a no-op** — the step finishes silently with no entry in `results`. Apps that want an "else" path declare a sentinel branch.

```ts
wf.route(
  'handle',
  (ctx) => ctx.results.classify.kind,
  {
    billing:  async (ctx) => handleBilling(ctx),
    shipping: async (ctx) => handleShipping(ctx),
  },
)
// ctx.results.handle is the union of branch returns — and optional, because of the no-op case
```

### `loop(name, handler, options)`

Bounded loop. Runs `handler(input, ctx)` up to `maxIterations` times. Only the last iteration's result is stored under `name`. `maxIterations === 0` is a no-op (no handler call, no `results` entry).

```ts
wf.loop(
  'refine',
  async (input: string, ctx) => improveQuality(input),
  {
    maxIterations: 5,
    until: (result) => result.score >= 0.95,
    feedback: (result) => result.data,    // next iteration's input
    mapInput: (ctx) => ctx.input.rawData, // first iteration's input
  },
)
```

| Option | Required | Behavior |
|---|---|---|
| `maxIterations` | yes | Hard cap. Loops always terminate |
| `until(result, iter)` | no | Exit early when this returns `true`. `iter` is 1-based |
| `feedback(result)` | no | Transform `result` → next iteration's input. Omit to reuse the prior input |
| `mapInput(ctx)` | no | Derive the first iteration's input from context. Defaults to `ctx.input` |

### `run(input)`

Execute every queued step. On success returns `{ results, duration }` (typed; `duration` is `performance.now()` delta in ms).

On any step throw: the throw is wrapped in `WorkflowError`, every completed step's compensator runs in reverse, and the workflow rethrows. If any compensator also throws, the rollback completes and then `CompensationError` is thrown instead. The original step error is preserved as `WorkflowError.cause` (or `CompensationError.cause`).

### `plan()`

Read-only snapshot of the queued steps as a `WorkflowStep[]`. Useful for tests and tools that want to render the workflow shape without running it.

## `defineWorkflow<Input>(name)`

```ts
function defineWorkflow<Input = unknown>(name: string): Workflow<Input>
```

Sugar over `new Workflow<Input>(name)`. Mirrors `defineSchema(...)` from `@strav/database`. Pass the input generic up-front; results accumulate via the builder.

## `WorkflowContext<Input, Results>`

```ts
interface WorkflowContext<Input, Results extends Record<string, unknown>> {
  readonly input: Input
  readonly results: Results
}
```

What every handler receives. `input` is what the caller passed to `run()`; `results` is the typed accumulator of every prior step's return.

## `WorkflowResult<Results>`

```ts
interface WorkflowResult<Results extends Record<string, unknown>> {
  results: Results
  duration: number
}
```

Returned from `run()`. `duration` is wall-clock milliseconds (`performance.now()` delta from start to last step).

## Handler types

```ts
type StepHandler<Input, Results, R> =
  (ctx: WorkflowContext<Input, Results>) => Promise<R>

type LoopHandler<Input, Results, IterInput, R> =
  (input: IterInput, ctx: WorkflowContext<Input, Results>) => Promise<R>

type RouteResolver<Input, Results> =
  (ctx: WorkflowContext<Input, Results>) => string | Promise<string>

type Compensator<Input, Results> =
  (ctx: WorkflowContext<Input, Results>) => Promise<void>
```

Apps that extract a handler into its own module can type it directly with these:

```ts
const charge: StepHandler<{ orderId: string }, { validate: { total: number } }, { id: string }> =
  async (ctx) => chargeCard(ctx.results.validate.total)
```

## Option shapes

```ts
interface StepOptions<Input, Results> {
  compensate?: Compensator<Input, Results>
}

interface ParallelEntry<Input, Results, R> {
  name: string
  handler: StepHandler<Input, Results, R>
  compensate?: Compensator<Input, Results>
}

interface LoopOptions<Input, Results, IterInput, R> {
  maxIterations: number
  until?: (result: R, iteration: number) => boolean
  feedback?: (result: R) => IterInput
  mapInput?: (ctx: WorkflowContext<Input, Results>) => IterInput
}
```

## Errors

### `WorkflowError`

```ts
class WorkflowError extends StravError {
  code = 'workflow.step-failed'
  status = 500
  context: { step: string }
  cause: unknown   // the original throw (Error or non-Error)
}
```

Thrown when a step / parallel-entry / route-branch / loop-body handler throws. `context.step` names the failing step (for parallel, this is the parallel block's name, not the entry name); `cause` carries the original. Non-Error throws (`throw 'string'`) are coerced via `String()` for the message but preserved verbatim on `cause`.

### `CompensationError`

```ts
class CompensationError extends StravError {
  code = 'workflow.compensation-failed'
  status = 500
  context: {
    originalError: { message: string; name: string }
    failures: Array<{ step: string; message: string }>
  }
  cause: unknown   // the original step error
}
```

Thrown when one or more compensators throw during rollback. `context.failures` lists each failed compensator. The original step error is preserved as `cause` so apps can recover the underlying failure without parsing `originalError.message`.

```ts
interface CompensationFailure {
  step: string
  error: unknown
}
```

`CompensationError` consumes `CompensationFailure[]` at construction; the typed `context.failures` is the post-serialization shape.

## Plan introspection (advanced)

```ts
type WorkflowStep = SequentialStep | ParallelStep | RouteStep | LoopStep
```

The discriminated union of the internal plan. `Workflow.plan()` returns `readonly WorkflowStep[]` — useful for tests asserting "this workflow has the right shape" without running it, or for dev-tooling that renders the plan.

Each variant carries its `type` discriminator + `name` + kind-specific fields (`handler`, `entries`, `branches`, `maxIterations`, etc.). See `packages/workflow/src/step.ts` for the exact shape.
