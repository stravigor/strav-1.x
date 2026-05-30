/**
 * Public types for durable execution.
 *
 * A durable workflow is a *named*, registered definition: handlers are
 * keyed by node name so the runner can re-enter them across processes
 * after a crash. Apps don't pass closures into `start()` — they pass
 * a workflow name + input.
 *
 * `DurableContext` is what each step handler receives. `results` is the
 * accumulated typed return of every prior step; `runId` lets apps log
 * + correlate with the durable record; `attempt` is 1-based and lets
 * apps switch behavior on retry (e.g. tighten timeouts).
 *
 * `RunSnapshot` is what `DurableRunner.find(runId)` returns — the
 * shape app code uses to poll a run from outside (UI status pages, the
 * `durable:status` CLI command in a later slice).
 */

/**
 * Run lifecycle states:
 *
 *   - `pending`     — row INSERTed; no advance has run yet.
 *   - `running`     — a worker is mid-step or in-flight.
 *   - `waiting`     — node parked itself (sleep, waitForSignal,
 *                     childWorkflow). The cursor doesn't move until
 *                     the wakeup condition fires.
 *   - `compensating`— terminal failure; the saga is rolling back.
 *   - `completed`   — every node finished; `result` populated.
 *   - `failed`      — compensation done (or no compensation needed);
 *                     `error` populated.
 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'compensating'
  | 'completed'
  | 'failed'

export interface DurableContext {
  /** Workflow input — the object passed to `DurableRunner.start(name, input)`. */
  readonly input: Record<string, unknown>
  /** Results from every prior node, keyed by node name. */
  readonly results: Record<string, unknown>
  /** Durable run id (the row PK). Useful for logging / correlation. */
  readonly runId: string
  /** 1-based retry counter for this step. `1` on first run. */
  readonly attempt: number
}

/** Context handed to a `.loop(...)` body — same as `DurableContext` plus the iteration counter. */
export interface DurableLoopContext extends DurableContext {
  /** 0-based iteration number. */
  readonly iteration: number
}

export interface RunSnapshot {
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

/** Step handler — receives the durable context, returns the step's result. */
export type DurableStepHandler = (ctx: DurableContext) => Promise<unknown>

/** Saga rollback handler. Same context shape; return ignored. */
export type DurableCompensator = (ctx: DurableContext) => Promise<void>

export interface DurableStepOptions {
  compensate?: DurableCompensator
  /** Hard cap on attempts. Default `3`. Includes the first attempt. */
  maxAttempts?: number
  /**
   * Backoff function — input is the attempt number that just failed
   * (1-based), output is the delay in seconds before the next attempt.
   * Default: exponential `2 ** attempt` capped at 60s.
   */
  backoff?: (failedAttempt: number) => number
}

// ─── Node variants (V2) ──────────────────────────────────────────────────

/**
 * One sequential step. The cursor advances by 1 once the handler
 * succeeds. Failures retry up to `maxAttempts`; exhaustion triggers
 * reverse-order saga compensation.
 */
export interface DurableStep {
  type: 'step'
  name: string
  handler: DurableStepHandler
  compensate?: DurableCompensator
  maxAttempts: number
  backoff: (failedAttempt: number) => number
}

/**
 * Park the run for a fixed duration. The runner schedules a delayed
 * advance via `queue.dispatchLater(delaySec)` and marks the run as
 * `waiting`. On wake-up the node is journaled and the cursor moves
 * on.
 *
 * `delay` is either a number of seconds or a context-aware function
 * that returns one (so apps can sleep until a wall-clock target
 * encoded in `ctx.input` / `ctx.results`).
 */
export interface DurableSleep {
  type: 'sleep'
  name: string
  delay: number | ((ctx: DurableContext) => number | Promise<number>)
}

/**
 * Pause the run until an external `runner.signal(runId, signalName,
 * payload?)` call fires. The signal's `payload` lands as the node's
 * result. Useful for human-in-the-loop approvals, third-party
 * webhooks, async-out / async-in handshakes.
 *
 * `signalName` is either a literal or a context-aware function (so
 * the listener name can depend on `ctx.input`).
 */
export interface DurableWaitForSignal {
  type: 'waitForSignal'
  name: string
  signalName: string | ((ctx: DurableContext) => string)
}

/**
 * Run a set of named branches concurrently. Each branch is a single
 * handler; the parallel node completes when every branch has — its
 * result is `{ [branch]: result }`. If any branch throws, the WHOLE
 * node fails and the failure path follows the same retry +
 * compensation rules as `step`.
 *
 * V2 scope — no per-branch retries, no per-branch journaling. The
 * whole `Promise.all(...)` runs inside one advance.
 */
export interface DurableParallel {
  type: 'parallel'
  name: string
  branches: Record<string, DurableStepHandler>
  maxAttempts: number
  backoff: (failedAttempt: number) => number
}

/**
 * Pick one of N named branches based on a `select(ctx)` predicate.
 * The chosen branch's handler runs; its return lands as the node's
 * result alongside the chosen key. Unknown selection keys throw.
 */
export interface DurableRoute {
  type: 'route'
  name: string
  select: (ctx: DurableContext) => string | Promise<string>
  branches: Record<string, DurableStepHandler>
  maxAttempts: number
  backoff: (failedAttempt: number) => number
}

/**
 * Repeat `body(ctx, i)` while `condition(ctx, iter)` returns true,
 * up to `maxIterations`. Each iteration is journaled separately
 * (`<name>#<iter>`) so a crash mid-loop resumes from the next
 * un-journaled iteration. The node's final result is the array of
 * per-iteration returns.
 */
export interface DurableLoop {
  type: 'loop'
  name: string
  condition: (ctx: DurableContext, iter: number) => boolean | Promise<boolean>
  body: (ctx: DurableLoopContext) => Promise<unknown>
  /** Safety ceiling on iterations. Default `1000`. */
  maxIterations: number
  maxAttempts: number
  backoff: (failedAttempt: number) => number
}

/**
 * Spawn a child workflow (by registered name) and wait for it to
 * complete. The parent re-polls the child's status via a delayed
 * advance — no parent_run_id column needed, no cross-row push. Child
 * `failed` propagates as a failure on this node (which retries +
 * compensates like any other).
 *
 * `start(ctx)` returns `{ name, input }` — the child workflow name
 * (must be registered) and its input object.
 */
export interface DurableChildWorkflow {
  type: 'childWorkflow'
  name: string
  start: (
    ctx: DurableContext,
  ) => Promise<{ name: string; input?: Record<string, unknown> }> | {
    name: string
    input?: Record<string, unknown>
  }
  /** How often the runner re-polls the child's status (seconds). Default `2`. */
  pollIntervalSec: number
}

export type DurableNode =
  | DurableStep
  | DurableSleep
  | DurableWaitForSignal
  | DurableParallel
  | DurableRoute
  | DurableLoop
  | DurableChildWorkflow
