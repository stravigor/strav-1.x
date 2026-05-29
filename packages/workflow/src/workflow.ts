/**
 * `Workflow` — typed builder for sequential / parallel / route / loop
 * orchestration with saga-style compensation.
 *
 * Each builder call returns `this` widened by the new step's typed
 * return: the second `.step('charge', ...)` sees `ctx.results.validate`
 * as the precise shape returned by the first step's handler, not
 * `unknown`. Apps that don't care can omit generics — the builder still
 * runs untyped via `unknown`.
 *
 * Execution semantics (in order):
 *   - `step(name, fn, { compensate? })` — runs `fn(ctx)`, stores the
 *     return under `ctx.results[name]`. Throws abort the run; compensation
 *     for any *completed* step runs in reverse order.
 *   - `parallel(name, entries)` — every entry's handler runs concurrently
 *     via `Promise.all`; each entry's result is stored under its own
 *     `name` (flat, not nested under the parallel block's name). One
 *     entry's throw cancels the rest only insofar as `Promise.all`
 *     rejects on first error; in-flight handlers still finish, the
 *     workflow then aborts.
 *   - `route(name, resolver, branches)` — `resolver(ctx)` returns a
 *     branch key. If the key matches a branch, that branch runs and its
 *     return is stored under `name`. Unknown key → step completes
 *     silently with no result entry.
 *   - `loop(name, handler, options)` — runs the handler up to
 *     `maxIterations` times, optionally exiting early when `until`
 *     returns `true`. The first iteration's input is `mapInput?.(ctx)
 *     ?? ctx.input`; subsequent iterations get `feedback?.(prev)
 *     ?? prev_input`. Only the last result is stored under `name`.
 *     A workflow with `maxIterations: 0` runs the handler zero times
 *     and skips writing to `results`.
 *
 * Compensation:
 *   When a step throws, every previously-completed step's compensator
 *   (if any) runs in reverse declaration order. Parallel entries
 *   contribute their compensators in the order they were declared.
 *   `route` / `loop` don't carry compensators in V1 — apps wanting to
 *   roll back routed work should put the cleanup inside a normal
 *   `step()`. Compensator failures collect into a `CompensationError`
 *   that wraps the original step error; the workflow rethrows after the
 *   rollback pass.
 *
 * Workflows are stateful builders, not container-bound services. Apps
 * `new Workflow(name)` (or `defineWorkflow(name)`) where they need one;
 * shared workflows live in a module-level `export const`.
 */

import { CompensationError, type CompensationFailure } from './compensation_error.ts'
import type {
  LoopStep,
  ParallelStep,
  RouteStep,
  SequentialStep,
  WorkflowStep,
} from './step.ts'
import type {
  Compensator,
  LoopHandler,
  LoopOptions,
  ParallelEntry,
  RouteResolver,
  StepHandler,
  StepOptions,
  WorkflowContext,
  WorkflowResult,
} from './types.ts'
import { WorkflowError } from './workflow_error.ts'

export class Workflow<
  Input = unknown,
  Results extends Record<string, unknown> = {},
> {
  private readonly steps: WorkflowStep[] = []

  constructor(readonly name: string) {}

  /**
   * Append a sequential step. The handler's return type is woven into
   * the workflow's accumulated `Results` shape under `name`, so the
   * NEXT step's handler sees `ctx.results[name]` typed precisely.
   */
  step<K extends string, R>(
    name: K,
    handler: StepHandler<Input, Results, R>,
    options?: StepOptions<Input, Results>,
  ): Workflow<Input, Results & { [P in K]: R }> {
    const step: SequentialStep = {
      type: 'step',
      name,
      handler: handler as StepHandler,
      ...(options?.compensate ? { compensate: options.compensate as Compensator } : {}),
    }
    this.steps.push(step)
    return this as unknown as Workflow<Input, Results & { [P in K]: R }>
  }

  /**
   * Append a fan-out of handlers run via `Promise.all`. Each entry's
   * result lands under its own `entry.name` — flat, not namespaced
   * under the parallel block's `name`. Apps that need nesting can map
   * the results post-run or wrap inside a `step()`.
   */
  parallel<Entries extends ReadonlyArray<ParallelEntry<Input, Results, unknown>>>(
    name: string,
    entries: Entries,
  ): Workflow<
    Input,
    Results & {
      [P in Entries[number] as P['name']]: Awaited<ReturnType<P['handler']>>
    }
  > {
    const step: ParallelStep = {
      type: 'parallel',
      name,
      entries: entries as unknown as ParallelEntry[],
    }
    this.steps.push(step)
    return this as unknown as Workflow<
      Input,
      Results & {
        [P in Entries[number] as P['name']]: Awaited<ReturnType<P['handler']>>
      }
    >
  }

  /**
   * Conditional dispatch. `resolver(ctx)` returns a branch key; if it
   * matches a `branches` entry, that handler runs and its return goes
   * under `name`. Unknown keys are a no-op — the step finishes silently
   * with no entry in `results`. Apps that need an "else" path declare
   * a sentinel branch (e.g. `default: handler`) and have the resolver
   * fall through to it.
   */
  route<K extends string, Branches extends Record<string, StepHandler<Input, Results, unknown>>>(
    name: K,
    resolver: RouteResolver<Input, Results>,
    branches: Branches,
  ): Workflow<
    Input,
    Results & { [P in K]?: Awaited<ReturnType<Branches[keyof Branches]>> }
  > {
    const step: RouteStep = {
      type: 'route',
      name,
      resolver: resolver as RouteResolver,
      branches: branches as unknown as Record<string, StepHandler>,
    }
    this.steps.push(step)
    return this as unknown as Workflow<
      Input,
      Results & { [P in K]?: Awaited<ReturnType<Branches[keyof Branches]>> }
    >
  }

  /**
   * Bounded loop. Runs `handler(input, ctx)` up to `maxIterations`
   * times, exiting early when `until?(result, iter)` returns `true`.
   * Only the last result is stored under `name`. `maxIterations === 0`
   * is a no-op.
   */
  loop<K extends string, IterInput, R>(
    name: K,
    handler: LoopHandler<Input, Results, IterInput, R>,
    options: LoopOptions<Input, Results, IterInput, R>,
  ): Workflow<Input, Results & { [P in K]: R }> {
    const step: LoopStep = {
      type: 'loop',
      name,
      handler: handler as LoopHandler,
      maxIterations: options.maxIterations,
      ...(options.until ? { until: options.until as (r: unknown, i: number) => boolean } : {}),
      ...(options.feedback ? { feedback: options.feedback as (r: unknown) => unknown } : {}),
      ...(options.mapInput
        ? {
            mapInput: options.mapInput as (ctx: {
              input: unknown
              results: Record<string, unknown>
            }) => unknown,
          }
        : {}),
    }
    this.steps.push(step)
    return this as unknown as Workflow<Input, Results & { [P in K]: R }>
  }

  /**
   * Execute every queued step against `input`. Returns `{ results,
   * duration }`. Throws `WorkflowError` (or `CompensationError` if any
   * compensator also failed) on any step throw; on success the
   * `results` object is fully typed.
   */
  async run(input: Input): Promise<WorkflowResult<Results>> {
    const start = performance.now()
    const results: Record<string, unknown> = {}
    const ctx: WorkflowContext<Input, Results> = {
      input,
      results: results as Results,
    }
    const completed: WorkflowStep[] = []

    for (const step of this.steps) {
      try {
        await this.execute(step, ctx, results)
        completed.push(step)
      } catch (error) {
        const wrapped =
          error instanceof WorkflowError
            ? error
            : new WorkflowError(step.name, error)
        await this.compensate(completed, ctx, wrapped)
        throw wrapped
      }
    }

    return {
      results: results as Results,
      duration: performance.now() - start,
    }
  }

  /** Expose the queued plan for introspection / tests. Read-only snapshot. */
  plan(): readonly WorkflowStep[] {
    return [...this.steps]
  }

  // ─── Step dispatch ──────────────────────────────────────────────────────

  private async execute(
    step: WorkflowStep,
    ctx: WorkflowContext<Input, Results>,
    results: Record<string, unknown>,
  ): Promise<void> {
    switch (step.type) {
      case 'step': {
        const value = await step.handler(ctx as WorkflowContext)
        results[step.name] = value
        return
      }
      case 'parallel': {
        const settled = await Promise.all(
          step.entries.map(async (entry) => ({
            name: entry.name,
            value: await entry.handler(ctx as WorkflowContext),
          })),
        )
        for (const r of settled) results[r.name] = r.value
        return
      }
      case 'route': {
        const key = await step.resolver(ctx as WorkflowContext)
        const branch = step.branches[key]
        if (!branch) return // unknown branch — silent no-op
        const value = await branch(ctx as WorkflowContext)
        results[step.name] = value
        return
      }
      case 'loop': {
        if (step.maxIterations <= 0) return
        const seed = step.mapInput
          ? step.mapInput({ input: ctx.input as unknown, results })
          : (ctx.input as unknown)
        let iterInput = seed
        let lastResult: unknown
        for (let i = 0; i < step.maxIterations; i++) {
          lastResult = await step.handler(iterInput, ctx as WorkflowContext)
          if (step.until?.(lastResult, i + 1)) break
          if (step.feedback) iterInput = step.feedback(lastResult)
        }
        results[step.name] = lastResult
        return
      }
    }
  }

  // ─── Saga compensation ──────────────────────────────────────────────────

  private async compensate(
    completed: readonly WorkflowStep[],
    ctx: WorkflowContext<Input, Results>,
    originalError: WorkflowError,
  ): Promise<void> {
    const failures: CompensationFailure[] = []

    // Reverse-order: first declared = last compensated. Mirrors how
    // database transactions roll back stacked savepoints.
    for (let i = completed.length - 1; i >= 0; i--) {
      const step = completed[i]!
      for (const c of compensatorsFor(step)) {
        try {
          await c.compensate(ctx as WorkflowContext)
        } catch (err) {
          failures.push({ step: c.name, error: err })
        }
      }
    }

    if (failures.length > 0) {
      throw new CompensationError(originalError, failures)
    }
  }
}

function compensatorsFor(
  step: WorkflowStep,
): readonly { name: string; compensate: Compensator }[] {
  switch (step.type) {
    case 'step':
      return step.compensate
        ? [{ name: step.name, compensate: step.compensate as Compensator }]
        : []
    case 'parallel':
      return step.entries
        .filter((e): e is ParallelEntry & { compensate: Compensator } => Boolean(e.compensate))
        .map((e) => ({ name: e.name, compensate: e.compensate as Compensator }))
    default:
      return []
  }
}
