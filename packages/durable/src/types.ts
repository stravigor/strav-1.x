/**
 * Public types for durable execution.
 *
 * A durable workflow is a *named*, registered definition: handlers are
 * keyed by step name so the runner can re-enter them across processes
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

export type RunStatus = 'pending' | 'running' | 'compensating' | 'completed' | 'failed'

export interface DurableContext {
  /** Workflow input — the object passed to `DurableRunner.start(name, input)`. */
  readonly input: Record<string, unknown>
  /** Results from every prior step, keyed by step name. */
  readonly results: Record<string, unknown>
  /** Durable run id (the row PK). Useful for logging / correlation. */
  readonly runId: string
  /** 1-based retry counter for this step. `1` on first run. */
  readonly attempt: number
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

/**
 * Internal step record. Apps don't construct this directly — the
 * `DurableWorkflow` builder pushes one per `.step()` call. Exported
 * so tests and introspection tools can read the plan from
 * `workflow.steps`.
 */
export interface DurableStep {
  type: 'step'
  name: string
  handler: DurableStepHandler
  compensate?: DurableCompensator
  maxAttempts: number
  backoff: (failedAttempt: number) => number
}
