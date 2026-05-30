/**
 * `DurableRunner` — the engine that owns the durable execution state
 * machine.
 *
 * Four load-bearing methods:
 *
 *   1. `start(name, input)` — INSERTs a new run row, dispatches the
 *      first `DurableAdvanceJob` for it inside the same transaction
 *      (queue-until-commit via `@strav/queue`'s `DatabaseQueue`).
 *      Returns the run id; the workflow runs asynchronously on the
 *      queue.
 *
 *   2. `advance(runId)` — the job handler. Acquires a row lock,
 *      resolves the node at `current_step`, dispatches by node-type
 *      (`step` / `sleep` / `waitForSignal` / `parallel` / `route` /
 *      `loop` / `childWorkflow`), journals the result, and either
 *      re-enqueues itself, parks the run as `waiting`, or — on
 *      terminal failure — kicks off compensation.
 *
 *   3. `compensate(runId)` — walks the journal in reverse order
 *      running each step's `compensate` callback. On clean
 *      completion the run lands in `failed`. Failures during
 *      compensation are logged but don't block the rest of the
 *      rollback (compensators must be idempotent).
 *
 *   4. `signal(runId, signalName, payload?)` — wakes a run parked on
 *      a `waitForSignal` node. Writes the journal entry, clears the
 *      awaiting marker, dispatches an advance.
 *
 * Apps don't usually call `advance` / `compensate` directly — the
 * `DurableAdvanceJob` and `DurableCompensateJob` classes wrap them.
 */

import { type Database, PostgresDatabase, type SchemaRegistry } from '@strav/database'
import { type Logger, ulid } from '@strav/kernel'
import type { JobClass, Queue } from '@strav/queue'
import { DurableError, RunNotFoundError } from './durable_error.ts'
import type {
  DurableContext,
  DurableNode,
  DurableStep,
  RunSnapshot,
  RunStatus,
} from './types.ts'
import type { WorkflowRegistry } from './workflow_registry.ts'

interface RunState {
  results: Record<string, unknown>
  stepAttempts: Record<string, number>
  /** `waitForSignal` markers — `{ [nodeName]: signalName }`. */
  awaitingSignals?: Record<string, string>
  /** Per-loop iteration state — `{ [nodeName]: { iteration, results[] } }`. */
  loopState?: Record<string, { iteration: number; results: unknown[] }>
  /** Per-child-workflow link — `{ [nodeName]: { childRunId } }`. */
  childRunIds?: Record<string, string>
}

interface RunRow {
  id: string
  workflow_name: string
  input: Record<string, unknown> | string
  status: RunStatus
  state: RunState | string
  current_step: number
  result: Record<string, unknown> | string | null
  error: string | null
  created_at: Date
  updated_at: Date
}

interface JournalRow {
  id: string
  run_id: string
  step_name: string
  status: 'completed' | 'failed'
  result: Record<string, unknown> | string | null
  error: string | null
  attempts: number
  completed_at: Date
}

type Tx = { query: Database['query']; queryOne: Database['queryOne']; execute: Database['execute'] }

type Outcome =
  /** Node completed; advance cursor + re-dispatch. */
  | { kind: 'completed'; value: unknown; attempt: number }
  /** Node has retries left; re-dispatch with delay. */
  | { kind: 'retry'; attempt: number; delaySec: number }
  /** Node exhausted retries; journal + compensate. */
  | { kind: 'failed'; attempt: number; error: string }
  /**
   * Node parked itself. `delaySec`, when set, schedules a wake-up
   * advance — for sleep and child-workflow polling. Undefined for
   * waitForSignal (an external `signal()` call resumes it).
   */
  | { kind: 'waiting'; delaySec?: number }

export interface DurableRunnerOptions {
  db: PostgresDatabase
  queue: Queue
  registry: WorkflowRegistry
  /**
   * Job classes the runner dispatches for advance / compensate. Passed
   * in as options so the runner stays decoupled from the Job module
   * (the Jobs themselves import the runner for DI — taking them as
   * options breaks the resulting cycle without forcing a third
   * intermediate module).
   *
   * `DurableProvider` wires the defaults
   * (`DurableAdvanceJob` / `DurableCompensateJob`); apps that subclass
   * the Jobs (custom logging, custom dead-letter routing) pass their
   * subclasses here.
   */
  advanceJob: JobClass
  compensateJob: JobClass
  /** Optional logger — picked up via `LogManager.channel('durable')` when wired by `DurableProvider`. */
  logger?: Logger
  /**
   * Optional SchemaRegistry — when supplied, callers can read it to
   * find the runs / journal schemas during boot DDL emission.
   */
  schemas?: SchemaRegistry
}

export class DurableRunner {
  private readonly db: PostgresDatabase
  private readonly queue: Queue
  private readonly registry: WorkflowRegistry
  private readonly advanceJob: JobClass
  private readonly compensateJob: JobClass
  private readonly logger: Logger | undefined

  constructor(options: DurableRunnerOptions) {
    this.db = options.db
    this.queue = options.queue
    this.registry = options.registry
    this.advanceJob = options.advanceJob
    this.compensateJob = options.compensateJob
    this.logger = options.logger
  }

  /** Register a workflow on the embedded registry. Sugar for `runner.registry.register(...)`. */
  register(workflow: Parameters<WorkflowRegistry['register']>[0]): this {
    this.registry.register(workflow)
    return this
  }

  /**
   * Start a new durable run. INSERTs the run row + dispatches the
   * first `advance` job in one transaction; the queue row commits
   * with the run row so a crash between INSERT and dispatch can't
   * orphan either.
   */
  async start(workflowName: string, input: Record<string, unknown> = {}): Promise<string> {
    this.registry.get(workflowName)
    const runId = ulid()
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO "strav_workflow_runs"
           (id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'pending', $4::jsonb, 0, NULL, NULL, now(), now())`,
        [runId, workflowName, JSON.stringify(input), JSON.stringify(emptyState())],
      )
      await this.queue.dispatch(this.advanceJob, { runId })
    })
    return runId
  }

  /** Read a run by id. Throws `RunNotFoundError` when missing. */
  async find(runId: string): Promise<RunSnapshot> {
    const row = await this.db.queryOne<RunRow>(
      `SELECT id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at
       FROM "strav_workflow_runs" WHERE id = $1`,
      [runId],
    )
    if (!row) throw new RunNotFoundError(runId)
    return toSnapshot(row)
  }

  /**
   * Advance handler. Loads the run, dispatches the current node by
   * type, and either re-enqueues (`continue`), parks (`waiting`),
   * retries with backoff, or kicks off compensation.
   */
  async advance(runId: string): Promise<void> {
    const shouldContinue = await this.db.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        `SELECT id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at
         FROM "strav_workflow_runs" WHERE id = $1 FOR UPDATE`,
        [runId],
      )
      if (!row) throw new RunNotFoundError(runId)
      if (row.status === 'completed' || row.status === 'failed') return false

      const wf = this.registry.get(row.workflow_name)
      const state = parseJson(row.state) as RunState
      ensureStateShape(state)
      const input = parseJson(row.input) as Record<string, unknown>

      if (row.current_step >= wf.steps.length) {
        await this.markCompleted(tx, runId, state.results)
        return false
      }

      const node = wf.steps[row.current_step] as DurableNode

      // Idempotent replay — if the node was already journaled
      // completed, skip the handler.
      const journaled = await tx.queryOne<JournalRow>(
        `SELECT id, run_id, step_name, status, result, error, attempts, completed_at
         FROM "strav_workflow_journal" WHERE run_id = $1 AND step_name = $2`,
        [runId, node.name],
      )
      if (journaled?.status === 'completed') {
        state.results[node.name] = parseJson(journaled.result)
        await this.advanceCursor(tx, runId, row.current_step + 1, state)
        return true
      }

      const attempt = (state.stepAttempts[node.name] ?? 0) + 1
      const ctx: DurableContext = {
        input,
        results: state.results,
        runId,
        attempt,
      }
      const outcome = await this.runNode(tx, node, ctx, state, runId, attempt)
      return this.applyOutcome(tx, runId, row.current_step, node, state, outcome)
    })

    if (shouldContinue) {
      await this.queue.dispatch(this.advanceJob, { runId })
    }
  }

  /**
   * Wake a run parked on a `waitForSignal` node. Writes the journal
   * entry with `payload` as the node's result, clears the awaiting
   * marker, and dispatches a fresh advance job to resume the next
   * node. No-op when no run is awaiting `signalName`.
   */
  async signal(runId: string, signalName: string, payload?: unknown): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        `SELECT id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at
         FROM "strav_workflow_runs" WHERE id = $1 FOR UPDATE`,
        [runId],
      )
      if (!row) throw new RunNotFoundError(runId)
      if (row.status !== 'waiting') return false
      const state = parseJson(row.state) as RunState
      ensureStateShape(state)
      const awaiting = state.awaitingSignals ?? {}
      const matchEntry = Object.entries(awaiting).find(([, name]) => name === signalName)
      if (matchEntry === undefined) return false
      const [nodeName] = matchEntry
      // Journal the wake-up so replay sees the signal as already received.
      await tx.execute(
        `INSERT INTO "strav_workflow_journal"
           (id, run_id, step_name, status, result, error, attempts, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'completed', $4::jsonb, NULL, 1, now(), now(), now())`,
        [ulid(), runId, nodeName, JSON.stringify(payload ?? null)],
      )
      delete awaiting[nodeName]
      state.awaitingSignals = awaiting
      state.results[nodeName] = payload ?? null
      await tx.execute(
        `UPDATE "strav_workflow_runs"
           SET status = 'running', state = $1::jsonb, current_step = current_step + 1, updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(state), runId],
      )
      await this.queue.dispatch(this.advanceJob, { runId })
      return true
    })
  }

  /**
   * Compensate handler. Walks the journal in reverse, calling each
   * registered compensator. Compensators that throw are logged but
   * don't halt the rollback. Only `step` nodes carry compensators in
   * V2 — other node types are skipped.
   */
  async compensate(runId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        `SELECT id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at
         FROM "strav_workflow_runs" WHERE id = $1 FOR UPDATE`,
        [runId],
      )
      if (!row) throw new RunNotFoundError(runId)
      if (row.status !== 'compensating') return

      const wf = this.registry.get(row.workflow_name)
      const state = parseJson(row.state) as RunState
      ensureStateShape(state)
      const input = parseJson(row.input) as Record<string, unknown>

      const journal = await tx.query<JournalRow>(
        `SELECT id, run_id, step_name, status, result, error, attempts, completed_at
         FROM "strav_workflow_journal" WHERE run_id = $1 ORDER BY completed_at ASC`,
        [runId],
      )
      const completedNames = journal
        .filter((j) => j.status === 'completed')
        .map((j) => j.step_name)
      const stepsByName = new Map<string, DurableNode>(wf.steps.map((s) => [s.name, s]))

      for (const name of [...completedNames].reverse()) {
        const node = stepsByName.get(name)
        if (node?.type !== 'step' || !node.compensate) continue
        try {
          await (node as DurableStep).compensate?.({
            input,
            results: state.results,
            runId,
            attempt: 1,
          })
        } catch (err) {
          this.logger?.error('Durable compensator threw', {
            runId,
            step: name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      await tx.execute(
        `UPDATE "strav_workflow_runs"
           SET status = 'failed', updated_at = now()
         WHERE id = $1`,
        [runId],
      )
    })
  }

  // ─── Node-type dispatch ──────────────────────────────────────────────────

  private async runNode(
    tx: Tx,
    node: DurableNode,
    ctx: DurableContext,
    state: RunState,
    runId: string,
    attempt: number,
  ): Promise<Outcome> {
    switch (node.type) {
      case 'step':
        return this.runStepLike(node, ctx, attempt, () => node.handler(ctx))
      case 'sleep':
        return this.runSleep(node, ctx, state, attempt)
      case 'waitForSignal':
        return this.runWaitForSignal(node, ctx, state)
      case 'parallel':
        return this.runStepLike(node, ctx, attempt, async () => {
          const entries = Object.entries(node.branches)
          const results = await Promise.all(
            entries.map(async ([key, handler]) => [key, await handler(ctx)] as const),
          )
          return Object.fromEntries(results)
        })
      case 'route':
        return this.runStepLike(node, ctx, attempt, async () => {
          const key = await node.select(ctx)
          const handler = node.branches[key]
          if (handler === undefined) {
            throw new DurableError(
              `DurableRunner: route "${node.name}" returned unknown branch "${key}". Branches: ${Object.keys(node.branches).join(', ')}`,
            )
          }
          const result = await handler(ctx)
          return { branch: key, result }
        })
      case 'loop':
        return this.runLoop(tx, node, ctx, state, runId, attempt)
      case 'childWorkflow':
        return this.runChildWorkflow(tx, node, ctx, state, runId, attempt)
    }
  }

  /** Common retry/failure envelope for nodes that look like one handler. */
  private async runStepLike(
    node: { name: string; maxAttempts: number; backoff: (n: number) => number },
    ctx: DurableContext,
    attempt: number,
    fn: () => Promise<unknown>,
  ): Promise<Outcome> {
    try {
      const value = await fn()
      return { kind: 'completed', value, attempt }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger?.warn('Durable node failed', {
        runId: ctx.runId,
        node: node.name,
        attempt,
        error,
      })
      if (attempt < node.maxAttempts) {
        return { kind: 'retry', attempt, delaySec: Math.max(0, node.backoff(attempt)) }
      }
      return { kind: 'failed', attempt, error }
    }
  }

  private async runSleep(
    node: import('./types.ts').DurableSleep,
    ctx: DurableContext,
    state: RunState,
    attempt: number,
  ): Promise<Outcome> {
    const requested =
      typeof node.delay === 'number' ? node.delay : await node.delay(ctx)
    const delaySec = Math.max(0, Math.floor(requested))
    const sleepKey = `__sleep__${node.name}`
    const previouslyDispatched = (state as unknown as Record<string, unknown>)[sleepKey] as
      | { dispatchedAt: number }
      | undefined
    if (previouslyDispatched !== undefined) {
      const elapsedSec = (Date.now() - previouslyDispatched.dispatchedAt) / 1000
      if (elapsedSec >= delaySec) {
        return { kind: 'completed', value: { sleptSec: delaySec }, attempt }
      }
      // Spurious early wake-up — re-park.
      return { kind: 'waiting', delaySec: Math.max(1, delaySec - elapsedSec) }
    }
    ;(state as unknown as Record<string, unknown>)[sleepKey] = { dispatchedAt: Date.now() }
    return { kind: 'waiting', delaySec }
  }

  private async runWaitForSignal(
    node: import('./types.ts').DurableWaitForSignal,
    ctx: DurableContext,
    state: RunState,
  ): Promise<Outcome> {
    const name = typeof node.signalName === 'string' ? node.signalName : node.signalName(ctx)
    const awaiting = state.awaitingSignals ?? {}
    awaiting[node.name] = name
    state.awaitingSignals = awaiting
    return { kind: 'waiting' }
  }

  private async runLoop(
    tx: Tx,
    node: import('./types.ts').DurableLoop,
    ctx: DurableContext,
    state: RunState,
    runId: string,
    attempt: number,
  ): Promise<Outcome> {
    const loops = state.loopState ?? {}
    const slot = loops[node.name] ?? { iteration: 0, results: [] }
    loops[node.name] = slot
    state.loopState = loops

    // Idempotent replay for this iteration — if the per-iteration
    // journal row already exists, treat the iteration as done.
    const iterName = `${node.name}#${slot.iteration}`
    const iterJournal = await tx.queryOne<JournalRow>(
      `SELECT id, run_id, step_name, status, result, error, attempts, completed_at
       FROM "strav_workflow_journal" WHERE run_id = $1 AND step_name = $2`,
      [runId, iterName],
    )
    if (iterJournal?.status === 'completed') {
      slot.results.push(parseJson(iterJournal.result))
      slot.iteration += 1
    }

    if (slot.iteration >= node.maxIterations) {
      return { kind: 'failed', attempt, error: `loop exceeded maxIterations (${node.maxIterations})` }
    }

    let keepGoing: boolean
    try {
      keepGoing = await node.condition(ctx, slot.iteration)
    } catch (err) {
      return {
        kind: 'failed',
        attempt,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (!keepGoing) {
      return { kind: 'completed', value: [...slot.results], attempt }
    }

    try {
      const value = await node.body({ ...ctx, iteration: slot.iteration })
      // Journal this iteration before bumping; failure mid-write
      // will replay this same iteration on resume (journal lookup
      // above short-circuits).
      await tx.execute(
        `INSERT INTO "strav_workflow_journal"
           (id, run_id, step_name, status, result, error, attempts, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'completed', $4::jsonb, NULL, $5, now(), now(), now())`,
        [ulid(), runId, iterName, JSON.stringify(value ?? null), attempt],
      )
      slot.results.push(value)
      slot.iteration += 1
      // Keep current_step pinned; re-dispatch advance to evaluate
      // the next iteration in its own transaction.
      await tx.execute(
        `UPDATE "strav_workflow_runs" SET state = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(state), runId],
      )
      // 'continue' via a sentinel — applyOutcome's `completed` path
      // is reserved for cursor-advancing nodes; here we want to
      // re-enter advance without moving the cursor.
      return { kind: 'waiting', delaySec: 0 }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (attempt < node.maxAttempts) {
        return { kind: 'retry', attempt, delaySec: Math.max(0, node.backoff(attempt)) }
      }
      return { kind: 'failed', attempt, error }
    }
  }

  private async runChildWorkflow(
    tx: Tx,
    node: import('./types.ts').DurableChildWorkflow,
    ctx: DurableContext,
    state: RunState,
    runId: string,
    attempt: number,
  ): Promise<Outcome> {
    const children = state.childRunIds ?? {}
    state.childRunIds = children
    let childId = children[node.name]

    if (childId === undefined) {
      let spec: { name: string; input?: Record<string, unknown> }
      try {
        spec = await node.start(ctx)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        if (attempt < 1) {
          return { kind: 'retry', attempt, delaySec: 0 }
        }
        return { kind: 'failed', attempt, error }
      }
      childId = await this.start(spec.name, spec.input ?? {})
      children[node.name] = childId
      await tx.execute(
        `UPDATE "strav_workflow_runs" SET state = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(state), runId],
      )
      return { kind: 'waiting', delaySec: node.pollIntervalSec }
    }

    const child = await tx.queryOne<RunRow>(
      `SELECT id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at
       FROM "strav_workflow_runs" WHERE id = $1`,
      [childId],
    )
    if (!child) {
      return {
        kind: 'failed',
        attempt,
        error: `child workflow run "${childId}" disappeared`,
      }
    }
    if (child.status === 'completed') {
      return { kind: 'completed', value: parseJson(child.result), attempt }
    }
    if (child.status === 'failed') {
      return {
        kind: 'failed',
        attempt,
        error: child.error ?? 'child workflow failed without error message',
      }
    }
    // pending / running / waiting / compensating → keep polling.
    return { kind: 'waiting', delaySec: node.pollIntervalSec }
  }

  // ─── Outcome → state mutation ───────────────────────────────────────────

  private async applyOutcome(
    tx: Tx,
    runId: string,
    currentStep: number,
    node: DurableNode,
    state: RunState,
    outcome: Outcome,
  ): Promise<boolean> {
    switch (outcome.kind) {
      case 'completed':
        await tx.execute(
          `INSERT INTO "strav_workflow_journal"
             (id, run_id, step_name, status, result, error, attempts, completed_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'completed', $4::jsonb, NULL, $5, now(), now(), now())`,
          [ulid(), runId, node.name, JSON.stringify(outcome.value ?? null), outcome.attempt],
        )
        state.results[node.name] = outcome.value
        delete state.stepAttempts[node.name]
        if (node.type === 'loop' && state.loopState !== undefined) {
          delete state.loopState[node.name]
        }
        if (node.type === 'childWorkflow' && state.childRunIds !== undefined) {
          delete state.childRunIds[node.name]
        }
        clearSleepKey(state, node)
        await this.advanceCursor(tx, runId, currentStep + 1, state)
        return true
      case 'retry':
        state.stepAttempts[node.name] = outcome.attempt
        await tx.execute(
          `UPDATE "strav_workflow_runs" SET state = $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify(state), runId],
        )
        await this.queue.dispatchLater(outcome.delaySec, this.advanceJob, { runId })
        return false
      case 'failed':
        await tx.execute(
          `INSERT INTO "strav_workflow_journal"
             (id, run_id, step_name, status, result, error, attempts, completed_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'failed', NULL, $4, $5, now(), now(), now())`,
          [ulid(), runId, node.name, outcome.error, outcome.attempt],
        )
        await tx.execute(
          `UPDATE "strav_workflow_runs"
             SET status = 'compensating', state = $1::jsonb, error = $2, updated_at = now()
           WHERE id = $3`,
          [JSON.stringify(state), outcome.error, runId],
        )
        await this.queue.dispatch(this.compensateJob, { runId })
        return false
      case 'waiting':
        await tx.execute(
          `UPDATE "strav_workflow_runs"
             SET status = 'waiting', state = $1::jsonb, updated_at = now()
           WHERE id = $2`,
          [JSON.stringify(state), runId],
        )
        if (outcome.delaySec !== undefined) {
          await this.queue.dispatchLater(outcome.delaySec, this.advanceJob, { runId })
        }
        return false
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async markCompleted(
    tx: Tx,
    runId: string,
    results: Record<string, unknown>,
  ): Promise<void> {
    await tx.execute(
      `UPDATE "strav_workflow_runs"
         SET status = 'completed', state = $1::jsonb, result = $2::jsonb, updated_at = now()
       WHERE id = $3`,
      [
        JSON.stringify({ ...emptyState(), results }),
        JSON.stringify(results),
        runId,
      ],
    )
  }

  private async advanceCursor(
    tx: Tx,
    runId: string,
    nextStep: number,
    state: RunState,
  ): Promise<void> {
    await tx.execute(
      `UPDATE "strav_workflow_runs"
         SET current_step = $1, state = $2::jsonb, status = 'running', updated_at = now()
       WHERE id = $3`,
      [nextStep, JSON.stringify(state), runId],
    )
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────

function emptyState(): RunState {
  return { results: {}, stepAttempts: {} }
}

function ensureStateShape(state: RunState): void {
  if (state.results === undefined) state.results = {}
  if (state.stepAttempts === undefined) state.stepAttempts = {}
}

function clearSleepKey(state: RunState, node: DurableNode): void {
  const key = `__sleep__${node.name}`
  if (key in state) {
    delete (state as unknown as Record<string, unknown>)[key]
  }
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function toSnapshot(row: RunRow): RunSnapshot {
  const state = parseJson(row.state) as RunState | null
  return {
    id: row.id,
    workflowName: row.workflow_name,
    status: row.status,
    input: parseJson(row.input) as Record<string, unknown>,
    results: state?.results ?? {},
    currentStep: row.current_step,
    result: parseJson(row.result) as Record<string, unknown> | null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Re-export for tests that want to construct a Database stub without
// depending on the parent module's import order.
export type { DurableError } from './durable_error.ts'
