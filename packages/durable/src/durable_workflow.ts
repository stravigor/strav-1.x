/**
 * `DurableWorkflow` — the builder apps use to declare a named,
 * registered, crash-resumable workflow.
 *
 * Mirrors the `.step(name, handler, { compensate?, maxAttempts? })`
 * surface from `@strav/workflow` so simple migrations are mostly
 * copy-paste, but the semantics differ in three important ways:
 *
 *   1. Workflows are *named* and live in a registry. Steps are looked
 *      up by name when an `advance` job picks them off the queue —
 *      apps don't pass closures to `runner.start()`.
 *
 *   2. Each step is its own crash boundary. A step that's already
 *      journaled completed is skipped on replay; a step that throws
 *      is retried up to `maxAttempts` with `backoff` (default
 *      exponential, capped at 60s); a step that exhausts its
 *      attempts triggers reverse-order saga compensation.
 *
 *   3. Step handlers must be *resolvable across processes*. The
 *      registry holds the handler function; the queue payload carries
 *      only the run id + step name. Handlers can close over module-
 *      level state but NOT request-scoped variables — the
 *      `advance` job may run in a worker that never saw the request
 *      that started the workflow.
 *
 * V1 ships sequential `.step()` only. V2 adds `.parallel` / `.route`
 * / `.loop` / `.sleep` / `.waitForSignal` / `.childWorkflow`.
 */

import { DurableError } from './durable_error.ts'
import type {
  DurableStep,
  DurableStepHandler,
  DurableStepOptions,
} from './types.ts'

const DEFAULT_MAX_ATTEMPTS = 3
const MAX_BACKOFF_SECONDS = 60
const defaultBackoff = (failedAttempt: number): number =>
  Math.min(2 ** failedAttempt, MAX_BACKOFF_SECONDS)

export class DurableWorkflow {
  readonly name: string
  private readonly _steps: DurableStep[] = []
  private readonly _names = new Set<string>()

  constructor(name: string) {
    if (!name) {
      throw new DurableError('DurableWorkflow: name must be a non-empty string.')
    }
    this.name = name
  }

  /** Read-only snapshot of the queued steps. */
  get steps(): readonly DurableStep[] {
    return this._steps
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
    const step: DurableStep = {
      type: 'step',
      name,
      handler,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoff: options?.backoff ?? defaultBackoff,
    }
    if (options?.compensate) step.compensate = options.compensate
    this._steps.push(step)
    return this
  }

  /** Throw if the step name has already been used in this workflow. */
  private claim(name: string): void {
    if (!name) {
      throw new DurableError(`DurableWorkflow("${this.name}"): step name must be non-empty.`)
    }
    if (this._names.has(name)) {
      throw new DurableError(
        `DurableWorkflow("${this.name}"): duplicate step name "${name}". Steps are journaled by name; collisions would break replay.`,
      )
    }
    this._names.add(name)
  }
}
