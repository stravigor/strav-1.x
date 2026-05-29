/**
 * Public types for the workflow runtime.
 *
 * The builder pattern (`Workflow.step(...).step(...)`) progressively widens
 * `Results` so each handler sees the typed return value of every prior
 * step. `Input` is the type the caller passes to `run(input)`.
 *
 * Public exports here are the shapes user code references when typing
 * handlers and compensation functions; the discriminated `WorkflowStep`
 * union lives in `step.ts` since it's an internal contract.
 */

/**
 * The per-invocation context handed to every step. `input` is what the
 * caller passed to `run(input)`; `results` accumulates each step's typed
 * return value under its declared name.
 */
export interface WorkflowContext<
  Input = unknown,
  Results extends Record<string, unknown> = {},
> {
  readonly input: Input
  readonly results: Results
}

/** Sequential / parallel / route step handler. Receives the full context. */
export type StepHandler<
  Input = unknown,
  Results extends Record<string, unknown> = {},
  R = unknown,
> = (ctx: WorkflowContext<Input, Results>) => Promise<R>

/**
 * Loop handler. Receives the current iteration's input (separate from
 * `ctx.input` so loops can transform between iterations via `feedback`)
 * plus the full context for read-only access to prior results.
 */
export type LoopHandler<
  Input = unknown,
  Results extends Record<string, unknown> = {},
  IterInput = unknown,
  R = unknown,
> = (input: IterInput, ctx: WorkflowContext<Input, Results>) => Promise<R>

/** Route resolver — returns the branch key for `route(name, resolver, branches)`. */
export type RouteResolver<
  Input = unknown,
  Results extends Record<string, unknown> = {},
> = (ctx: WorkflowContext<Input, Results>) => string | Promise<string>

/** Compensation function for saga rollback. Receives the same context the step did. */
export type Compensator<
  Input = unknown,
  Results extends Record<string, unknown> = {},
> = (ctx: WorkflowContext<Input, Results>) => Promise<void>

/** Per-step options — currently just `compensate` for the saga path. */
export interface StepOptions<
  Input = unknown,
  Results extends Record<string, unknown> = {},
> {
  compensate?: Compensator<Input, Results>
}

/** One branch of a `parallel(name, entries)` fan-out. */
export interface ParallelEntry<
  Input = unknown,
  Results extends Record<string, unknown> = {},
  R = unknown,
> {
  name: string
  handler: StepHandler<Input, Results, R>
  compensate?: Compensator<Input, Results>
}

/** Options for `loop(name, handler, options)`. */
export interface LoopOptions<
  Input = unknown,
  Results extends Record<string, unknown> = {},
  IterInput = unknown,
  R = unknown,
> {
  /** Hard cap on iterations. Required — loops always terminate. */
  maxIterations: number
  /** Stop when this predicate returns `true`. Receives the last result + 1-based iteration count. */
  until?: (result: R, iteration: number) => boolean
  /** Transform `result` into the next iteration's input. Omit for "same input every iteration". */
  feedback?: (result: R) => IterInput
  /** Derive the first iteration's input from the workflow context. Defaults to `ctx.input`. */
  mapInput?: (ctx: WorkflowContext<Input, Results>) => IterInput
}

/**
 * Return value of `workflow.run(input)`. `results` is fully typed when
 * the workflow's builder type carries the accumulated `Results` shape;
 * `duration` is wall-clock milliseconds (`performance.now()` delta).
 */
export interface WorkflowResult<Results extends Record<string, unknown> = Record<string, unknown>> {
  results: Results
  duration: number
}
