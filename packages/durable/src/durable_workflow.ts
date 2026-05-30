/**
 * `DurableWorkflow` — the builder apps use to declare a named,
 * registered, crash-resumable workflow.
 *
 * V1 surface: `.step(name, handler, options?)` — sequential, named,
 * journaled, retried, optionally saga-compensated.
 *
 * V2 surface adds five composite primitives that still occupy one
 * cursor slot each:
 *
 *   - `.sleep(name, delay)` — park for N seconds or a context-aware
 *     deadline.
 *   - `.waitForSignal(name, signalName)` — pause until
 *     `runner.signal(runId, signalName, payload?)` fires.
 *   - `.parallel(name, { branchA: fn, branchB: fn, ... })` — run
 *     every branch in `Promise.all`; whole-or-nothing failure.
 *   - `.route(name, select, branches)` — pick one branch by
 *     predicate.
 *   - `.loop(name, condition, body)` — iterate while `condition()`
 *     holds; each iteration is its own journal row.
 *   - `.childWorkflow(name, start)` — spawn another registered
 *     workflow and wait on it.
 *
 * Cursor model stays a flat integer (`current_step`) — every node,
 * primitive or composite, occupies one slot. Internal sub-state
 * (loop iteration counters, awaiting-signal names, child run ids)
 * lives in the run row's `state` JSONB.
 */

import { DurableError } from './durable_error.ts'
import type {
  DurableChildWorkflow,
  DurableCompensator,
  DurableContext,
  DurableLoop,
  DurableLoopContext,
  DurableNode,
  DurableParallel,
  DurableRoute,
  DurableSleep,
  DurableStep,
  DurableStepHandler,
  DurableStepOptions,
  DurableWaitForSignal,
} from './types.ts'

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_ITERATIONS = 1000
const DEFAULT_CHILD_POLL_SEC = 2
const MAX_BACKOFF_SECONDS = 60
const defaultBackoff = (failedAttempt: number): number =>
  Math.min(2 ** failedAttempt, MAX_BACKOFF_SECONDS)

export class DurableWorkflow {
  readonly name: string
  private readonly _nodes: DurableNode[] = []
  private readonly _names = new Set<string>()

  constructor(name: string) {
    if (!name) {
      throw new DurableError('DurableWorkflow: name must be a non-empty string.')
    }
    this.name = name
  }

  /**
   * Read-only snapshot of the declared nodes.
   *
   * Field is named `steps` for back-compat with V1 — every node
   * (`step`, `sleep`, `parallel`, …) carries a `type` discriminator
   * that callers branch on.
   */
  get steps(): readonly DurableNode[] {
    return this._nodes
  }

  /**
   * Append a sequential step. The handler's return is journaled and
   * stored under `results[name]`; the next step's handler sees it
   * through `ctx.results[name]`.
   *
   * `compensate` registers a saga rollback that runs in reverse
   * declaration order when a *later* step exhausts its retries.
   *
   * `maxAttempts` includes the first try. Default is 3 (= initial +
   * 2 retries). `backoff(failedAttempt)` returns seconds until the
   * next attempt; default is exponential capped at 60s.
   */
  step(name: string, handler: DurableStepHandler, options?: DurableStepOptions): this {
    this.claim(name)
    const node: DurableStep = {
      type: 'step',
      name,
      handler,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoff: options?.backoff ?? defaultBackoff,
    }
    if (options?.compensate) node.compensate = options.compensate
    this._nodes.push(node)
    return this
  }

  /**
   * Park the run for `delay` seconds (or a context-aware function
   * returning seconds). Marks the run `waiting`; the cursor advances
   * once the delayed advance fires.
   */
  sleep(
    name: string,
    delay: number | ((ctx: DurableContext) => number | Promise<number>),
  ): this {
    this.claim(name)
    const node: DurableSleep = { type: 'sleep', name, delay }
    this._nodes.push(node)
    return this
  }

  /**
   * Pause until `runner.signal(runId, signalName, payload?)` fires.
   * The payload becomes this node's result.
   */
  waitForSignal(
    name: string,
    signalName: string | ((ctx: DurableContext) => string),
  ): this {
    this.claim(name)
    const node: DurableWaitForSignal = { type: 'waitForSignal', name, signalName }
    this._nodes.push(node)
    return this
  }

  /**
   * Run every branch concurrently within a single advance. Returns
   * a `{ [branchName]: result }` object. Any branch throw fails the
   * whole node (retried + compensated together).
   */
  parallel(
    name: string,
    branches: Record<string, DurableStepHandler>,
    options?: { maxAttempts?: number; backoff?: (failedAttempt: number) => number },
  ): this {
    this.claim(name)
    if (Object.keys(branches).length === 0) {
      throw new DurableError(
        `DurableWorkflow("${this.name}").parallel("${name}"): at least one branch required.`,
      )
    }
    const node: DurableParallel = {
      type: 'parallel',
      name,
      branches,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoff: options?.backoff ?? defaultBackoff,
    }
    this._nodes.push(node)
    return this
  }

  /**
   * Pick one branch by `select(ctx)` predicate. The chosen handler's
   * return is the node's result; the chosen branch key is recorded
   * in `results[name].branch`.
   */
  route(
    name: string,
    select: (ctx: DurableContext) => string | Promise<string>,
    branches: Record<string, DurableStepHandler>,
    options?: { maxAttempts?: number; backoff?: (failedAttempt: number) => number },
  ): this {
    this.claim(name)
    if (Object.keys(branches).length === 0) {
      throw new DurableError(
        `DurableWorkflow("${this.name}").route("${name}"): at least one branch required.`,
      )
    }
    const node: DurableRoute = {
      type: 'route',
      name,
      select,
      branches,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoff: options?.backoff ?? defaultBackoff,
    }
    this._nodes.push(node)
    return this
  }

  /**
   * Repeat `body(ctx)` while `condition(ctx, iter)` returns true,
   * up to `maxIterations` (default 1000). Each iteration is its own
   * journal row keyed `<name>#<iter>` so a crash mid-loop resumes
   * from the next un-journaled iteration. The node's result is the
   * array of per-iteration returns.
   */
  loop(
    name: string,
    condition: (ctx: DurableContext, iter: number) => boolean | Promise<boolean>,
    body: (ctx: DurableLoopContext) => Promise<unknown>,
    options?: {
      maxIterations?: number
      maxAttempts?: number
      backoff?: (failedAttempt: number) => number
    },
  ): this {
    this.claim(name)
    const node: DurableLoop = {
      type: 'loop',
      name,
      condition,
      body,
      maxIterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoff: options?.backoff ?? defaultBackoff,
    }
    this._nodes.push(node)
    return this
  }

  /**
   * Spawn a registered child workflow and wait for it to complete.
   * The parent re-polls the child's status via a delayed advance —
   * no parent_run_id column needed. Child `failed` propagates as a
   * failure on this node.
   */
  childWorkflow(
    name: string,
    start: DurableChildWorkflow['start'],
    options?: { pollIntervalSec?: number },
  ): this {
    this.claim(name)
    const node: DurableChildWorkflow = {
      type: 'childWorkflow',
      name,
      start,
      pollIntervalSec: options?.pollIntervalSec ?? DEFAULT_CHILD_POLL_SEC,
    }
    this._nodes.push(node)
    return this
  }

  private claim(name: string): void {
    if (!name) {
      throw new DurableError(`DurableWorkflow("${this.name}"): node name must be non-empty.`)
    }
    if (this._names.has(name)) {
      throw new DurableError(
        `DurableWorkflow("${this.name}"): duplicate node name "${name}". Nodes are journaled by name; collisions would break replay.`,
      )
    }
    this._names.add(name)
  }
}

// Re-export `DurableCompensator` so the index barrel doesn't need to
// list it twice — it's part of `DurableStepOptions` and the
// step-builder signature.
export type { DurableCompensator }
