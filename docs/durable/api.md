# @strav/durable — API Reference

> **Status:** Reflects the durable foundation slice (M5.4). Sequential `.step()` with per-step retries + saga compensation. Parallel / route / loop / sleep / waitForSignal / childWorkflow in follow-up slices.

## Public exports

```ts
import {
  // Builder + factory + registry
  DurableWorkflow,
  defineDurable,
  WorkflowRegistry,
  // Engine
  DurableRunner,
  type DurableRunnerOptions,
  // Service-provider wiring
  DurableProvider,
  type DurableProviderOptions,
  // Queue jobs
  DurableAdvanceJob,
  DurableCompensateJob,
  type DurableAdvancePayload,
  type DurableCompensatePayload,
  // Schemas
  workflowRunsSchema,
  workflowJournalSchema,
  JOURNAL_UNIQUE_INDEX,
  // Shapes
  type DurableContext,
  type DurableStep,
  type DurableStepHandler,
  type DurableStepOptions,
  type DurableCompensator,
  type RunSnapshot,
  type RunStatus,
  // Errors
  DurableError,
  RunNotFoundError,
  WorkflowNotRegisteredError,
} from '@strav/durable'
```

## `DurableWorkflow`

```ts
class DurableWorkflow {
  readonly name: string
  readonly steps: readonly DurableStep[]

  constructor(name: string)

  step(
    name: string,
    handler: DurableStepHandler,
    options?: DurableStepOptions,
  ): this
}
```

The builder. Constructor takes a non-empty name; empty names throw. `.step()` rejects duplicate step names — the runner journals by name, so collisions would corrupt replay.

### `.step(name, handler, options?)`

| Option | Default | Behavior |
|---|---|---|
| `compensate` | none | Saga rollback. Runs in reverse order when a *later* step exhausts its retries |
| `maxAttempts` | `3` | Total attempts (initial + retries). Set `1` to disable retries |
| `backoff(failedAttempt)` | `2 ** attempt`, capped at 60s | Delay in seconds before the next attempt |

Handler receives a `DurableContext`; return value is JSON-stringified and stored in `ctx.results[stepName]` for downstream steps.

## `defineDurable(name, fn)`

```ts
function defineDurable(
  name: string,
  build: (workflow: DurableWorkflow) => DurableWorkflow,
): DurableWorkflow
```

Sugar over `new DurableWorkflow(name)`. Mirrors `defineSchema` / `defineMachine` / `defineWorkflow`.

## `WorkflowRegistry`

```ts
class WorkflowRegistry {
  register(workflow: DurableWorkflow): this
  registerAll(workflows: readonly DurableWorkflow[]): this
  get(name: string): DurableWorkflow   // throws WorkflowNotRegisteredError when missing
  has(name: string): boolean
  names(): string[]
}
```

Apps register workflows on the registry (bound by `DurableProvider`); the runner uses it to resolve workflows when advancing.

`register` throws on duplicate names — the runner journals steps by `(run, step name)`, so silently shadowing a registered workflow with a different shape would corrupt replays.

## `DurableRunner`

```ts
class DurableRunner {
  constructor(options: DurableRunnerOptions)

  register(workflow: DurableWorkflow): this   // sugar for runner.registry.register(...)

  start(workflowName: string, input?: Record<string, unknown>): Promise<string>
  find(runId: string): Promise<RunSnapshot>
  advance(runId: string): Promise<void>
  compensate(runId: string): Promise<void>
}

interface DurableRunnerOptions {
  db: PostgresDatabase
  queue: Queue
  registry: WorkflowRegistry
  advanceJob: JobClass
  compensateJob: JobClass
  logger?: Logger
  schemas?: SchemaRegistry
}
```

The engine. Apps don't usually call `advance` / `compensate` directly — the `DurableAdvanceJob` / `DurableCompensateJob` classes wrap them, and the Worker invokes them when their queue entries come up.

### `start(workflowName, input?)`

Validates the workflow is registered (throws `WorkflowNotRegisteredError` synchronously when not), then inside one Postgres transaction:

1. INSERTs a new `strav_workflow_runs` row with status `pending`.
2. Dispatches a `DurableAdvanceJob` for the new run id.

The two commit together — a crash between the INSERT and the dispatch can't orphan either side, because `DatabaseQueue`'s queue-until-commit semantics keep the dispatch in the same transaction.

Returns the run id (ULID). The workflow runs asynchronously on the queue.

### `find(runId)`

Reads the run row and returns a `RunSnapshot`. Throws `RunNotFoundError` when no row exists.

### `advance(runId)`

The `DurableAdvanceJob` handler. Runs inside one transaction:

1. `SELECT … FOR UPDATE` the run row — serializes concurrent advances for the same run.
2. Short-circuit if the run is `completed` / `failed`.
3. Resolve the workflow from the registry; pick the step at `current_step`.
4. If a journal row exists for `(run, step name)` with `status = completed`, skip the handler — bump the cursor as if the step just succeeded.
5. Otherwise call the handler with `ctx = { input, results, runId, attempt }`.
   - On return: INSERT the journal entry with status `completed`, write the result back to `state.results[step.name]`, bump `current_step`, mark status `running`. If the cursor is past the last step, mark `completed` and write the full `results` into the run's `result` column.
   - On throw: increment the per-step attempt counter on the run's `state.stepAttempts`. If `attempt < step.maxAttempts`, write the state and `dispatchLater(backoff)` the next `DurableAdvanceJob`. Otherwise INSERT a journal row with status `failed`, mark the run `compensating`, and dispatch `DurableCompensateJob`.
6. If a step succeeded (or was already journaled), enqueue the next `DurableAdvanceJob` OUTSIDE the transaction so the row lock doesn't span the next step's handler.

### `compensate(runId)`

The `DurableCompensateJob` handler. Walks every completed-journal entry for the run in reverse (last-completed → first), running the workflow's compensator for each step. Compensators that throw are logged but don't halt the rollback — apps should write idempotent compensators. When the walk finishes, marks the run `failed`.

## `DurableProvider`

```ts
class DurableProvider extends ServiceProvider {
  readonly name = 'durable'
  readonly dependencies = ['database']

  constructor(options: DurableProviderOptions)
}

interface DurableProviderOptions {
  queue: new (...args: any[]) => Queue
  advanceJob?: JobClass
  compensateJob?: JobClass
}
```

Wires the runner into the container.

- `register()`:
  - Binds `WorkflowRegistry` as a singleton.
  - Binds `DurableRunner` as a singleton; resolves `PostgresDatabase`, the queue class passed via options, the registry, and (optionally) `LogManager` + `SchemaRegistry`.
- `boot()`:
  - Registers `workflowRunsSchema` + `workflowJournalSchema` on the app's `SchemaRegistry` if one is bound (so `db:migrate:generate` picks them up).
  - Eager-resolves the runner so misconfiguration fails at boot.

**Why the queue class is a constructor option:** `@strav/queue` doesn't ship a `QueueProvider`. Apps bind their concrete queue driver (`DatabaseQueue` in production, `SyncQueue` in tests) in their own provider's `register()`. `DurableProvider` looks up that binding by the class you pass in.

### Custom Job classes

The `advanceJob` / `compensateJob` options default to the shipped `DurableAdvanceJob` / `DurableCompensateJob`. Apps that need custom logging, custom dead-letter routing, or extra container deps inside the handler subclass and pass their class:

```ts
@inject()
class LoggedAdvanceJob extends DurableAdvanceJob {
  constructor(runner: DurableRunner, private readonly metrics: MetricsService) {
    super(runner)
  }
  override async handle(ctx: JobContext<DurableAdvancePayload>): Promise<void> {
    this.metrics.increment('durable.advance')
    return super.handle(ctx)
  }
}

new DurableProvider({ queue: DatabaseQueue, advanceJob: LoggedAdvanceJob })
```

## Jobs

### `DurableAdvanceJob`

```ts
class DurableAdvanceJob extends Job<DurableAdvancePayload> {
  static readonly jobName = 'durable.advance'
  static readonly maxAttempts = 1

  constructor(runner: DurableRunner)
  handle(ctx: JobContext<DurableAdvancePayload>): Promise<void>
}

interface DurableAdvancePayload {
  runId: string
}
```

Payload is minimal — `{ runId }` only. The runner reads the rest off the row. `maxAttempts = 1` because retry semantics live INSIDE the runner; a throw here means the engine itself failed and should land in the queue's dead-letter via the standard `Worker` path.

### `DurableCompensateJob`

```ts
class DurableCompensateJob extends Job<DurableCompensatePayload> {
  static readonly jobName = 'durable.compensate'
  static readonly maxAttempts = 1

  constructor(runner: DurableRunner)
  handle(ctx: JobContext<DurableCompensatePayload>): Promise<void>
}

interface DurableCompensatePayload {
  runId: string
}
```

Same shape, calls `runner.compensate`.

## Schemas

```ts
const workflowRunsSchema    = defineSchema('strav_workflow_runs',    …)
const workflowJournalSchema = defineSchema('strav_workflow_journal', …)
const JOURNAL_UNIQUE_INDEX  = 'strav_workflow_journal_run_step_unique_idx'
```

**`strav_workflow_runs`** — the durable record of a single execution. Columns: `id` (ULID PK), `workflow_name`, `input` (jsonb), `status` (`pending` / `running` / `compensating` / `completed` / `failed`), `state` (jsonb — carries `results` + per-step retry counters), `current_step` (cursor into `workflow.steps`), `result` (jsonb, populated on completion), `error`, timestamps.

**`strav_workflow_journal`** — append-only per-step checkpoint log. Columns: `id`, `run_id`, `step_name`, `status` (`completed` / `failed`), `result` (jsonb), `error`, `attempts` (1-based final attempt count), `completed_at`, timestamps.

The composite `UNIQUE (run_id, step_name)` is provisioned by `DurableProvider` via `emitCreateIndex` rather than as part of the schema builder (no table-level unique in V1; see the index emit pattern in `docs/database/api.md`). It's belt-and-suspenders: the advance handler's `SELECT … FOR UPDATE` on the run row already serializes journal INSERTs for a given step.

## Shapes

### `DurableContext`

```ts
interface DurableContext {
  readonly input: Record<string, unknown>
  readonly results: Record<string, unknown>
  readonly runId: string
  readonly attempt: number
}
```

What each step handler (and compensator) receives.

- `input` — the object passed to `runner.start(name, input)`.
- `results` — per-step return values from every prior completed step, keyed by step name.
- `runId` — the run row PK. Use it as a log correlation id.
- `attempt` — 1-based for the current handler invocation. `1` on first run; goes to 2 on retry, etc. Compensators always see `1`.

### `RunSnapshot`

```ts
interface RunSnapshot {
  id: string
  workflowName: string
  status: RunStatus
  input: Record<string, unknown>
  results: Record<string, unknown>
  currentStep: number
  result: Record<string, unknown> | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

type RunStatus = 'pending' | 'running' | 'compensating' | 'completed' | 'failed'
```

What `runner.find()` returns. `result` is null until the run reaches `completed`; on completion it's the same as `results` (kept as a separate column for indexable run-level outcome queries).

### `DurableStep` (internal — exposed for tooling)

```ts
interface DurableStep {
  type: 'step'
  name: string
  handler: DurableStepHandler
  compensate?: DurableCompensator
  maxAttempts: number
  backoff: (failedAttempt: number) => number
}
```

The shape `workflow.steps[]` produces. Useful for tests asserting the workflow plan and for tools that render durable workflows.

## Errors

### `DurableError`

```ts
class DurableError extends StravError {
  code = 'durable.error'
  status = 500
}
```

Generic infrastructure failure. Builder validation throws this (duplicate step names, empty workflow names).

### `RunNotFoundError`

```ts
class RunNotFoundError extends StravError {
  code = 'durable.run-not-found'
  status = 404
  context: { runId: string }
}
```

Thrown by `runner.find` and `runner.advance` when the run id doesn't exist.

### `WorkflowNotRegisteredError`

```ts
class WorkflowNotRegisteredError extends StravError {
  code = 'durable.workflow-not-registered'
  status = 500
  context: { name: string; known: string[] }
}
```

Thrown by `registry.get`, by `runner.start` (synchronously), and by `runner.advance` when the run references a workflow no longer in the registry — e.g. an in-flight run survived a deploy that removed the workflow definition.
