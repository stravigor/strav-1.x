/**
 * `DurableRunner` — the engine that owns the durable execution state
 * machine.
 *
 * Three load-bearing methods:
 *
 *   1. `start(name, input)` — INSERTs a new run row, dispatches the
 *      first `DurableAdvanceJob` for it inside the same transaction
 *      (queue-until-commit via `@strav/queue`'s `DatabaseQueue`).
 *      Returns the run id; the workflow runs asynchronously on the
 *      queue.
 *
 *   2. `advance(runId)` — the job handler. Acquires a row lock,
 *      decides what step is next, looks for a completed journal
 *      entry to short-circuit (idempotent replay), runs the
 *      handler, journals the result, and either re-enqueues itself
 *      for the next step or — on failure — schedules a retry or
 *      kicks off compensation. The whole step body runs inside a
 *      DB transaction so partial writes can't escape.
 *
 *   3. `compensate(runId)` — walks the journal in reverse order
 *      running each step's `compensate` callback. On clean
 *      completion the run lands in `failed`. Failures during
 *      compensation are logged but don't block the rest of the
 *      rollback (compensators must be idempotent).
 *
 * Apps don't usually call `advance` / `compensate` directly — the
 * `DurableAdvanceJob` and `DurableCompensateJob` classes wrap them.
 */

import {
  type Database,
  PostgresDatabase,
  type SchemaRegistry,
} from '@strav/database'
import { type Logger, ulid } from '@strav/kernel'
import type { JobClass, Queue } from '@strav/queue'
import { RunNotFoundError } from './durable_error.ts'
import type { DurableStep, DurableContext, RunSnapshot, RunStatus } from './types.ts'
import type { WorkflowRegistry } from './workflow_registry.ts'

interface RunRow {
  id: string
  workflow_name: string
  input: Record<string, unknown> | string
  status: RunStatus
  state: { results?: Record<string, unknown>; stepAttempts?: Record<string, number> } | string
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
    // Validate workflow registration up-front so the caller sees a
    // synchronous error rather than a never-advancing run row.
    this.registry.get(workflowName)
    const runId = ulid()
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO "strav_workflow_runs"
           (id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'pending', $4::jsonb, 0, NULL, NULL, now(), now())`,
        [runId, workflowName, JSON.stringify(input), JSON.stringify({ results: {}, stepAttempts: {} })],
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
   * Advance handler. Runs inside one transaction:
   *
   *   1. SELECT FOR UPDATE the run row (serializes concurrent advances).
   *   2. Resolve the workflow + the step at `current_step`.
   *   3. If a completed journal row already exists for this step,
   *      treat the run as if the step just succeeded — bump
   *      `current_step` and either enqueue the next or mark
   *      `completed`.
   *   4. Otherwise call the handler. On success: journal +
   *      bump cursor + enqueue next (or mark `completed`). On
   *      throw: track the attempt; if there are retries left,
   *      enqueue a delayed advance; otherwise journal the failure
   *      and kick off compensation.
   */
  async advance(runId: string): Promise<void> {
    const workflow = await this.db.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        `SELECT id, workflow_name, input, status, state, current_step, result, error, created_at, updated_at
         FROM "strav_workflow_runs" WHERE id = $1 FOR UPDATE`,
        [runId],
      )
      if (!row) throw new RunNotFoundError(runId)
      if (row.status === 'completed' || row.status === 'failed') return null

      const wf = this.registry.get(row.workflow_name)
      const state = parseJson(row.state) as {
        results: Record<string, unknown>
        stepAttempts: Record<string, number>
      }
      const input = parseJson(row.input) as Record<string, unknown>

      if (row.current_step >= wf.steps.length) {
        await this.markCompleted(tx, runId, state.results)
        return null
      }

      const step = wf.steps[row.current_step]!

      // Idempotent replay — if we already journaled this step, skip
      // the handler and just advance the cursor.
      const journaled = await tx.queryOne<JournalRow>(
        `SELECT id, run_id, step_name, status, result, error, attempts, completed_at
         FROM "strav_workflow_journal" WHERE run_id = $1 AND step_name = $2`,
        [runId, step.name],
      )
      if (journaled?.status === 'completed') {
        state.results[step.name] = parseJson(journaled.result)
        await this.advanceCursor(tx, runId, row.current_step + 1, state)
        // Continue outside the transaction so we don't hold the row
        // lock across the next handler invocation.
        return { wf, runId, status: 'continue' as const }
      }

      const attempt = (state.stepAttempts[step.name] ?? 0) + 1
      const ctx: DurableContext = {
        input,
        results: state.results,
        runId,
        attempt,
      }
      try {
        const result = await step.handler(ctx)
        await tx.execute(
          `INSERT INTO "strav_workflow_journal"
             (id, run_id, step_name, status, result, error, attempts, completed_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'completed', $4::jsonb, NULL, $5, now(), now(), now())`,
          [ulid(), runId, step.name, JSON.stringify(result ?? null), attempt],
        )
        state.results[step.name] = result
        delete state.stepAttempts[step.name]
        await this.advanceCursor(tx, runId, row.current_step + 1, state)
        return { wf, runId, status: 'continue' as const }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.logger?.warn('Durable step failed', {
          runId,
          step: step.name,
          attempt,
          error: message,
        })
        if (attempt < step.maxAttempts) {
          state.stepAttempts[step.name] = attempt
          await tx.execute(
            `UPDATE "strav_workflow_runs" SET state = $1::jsonb, updated_at = now() WHERE id = $2`,
            [JSON.stringify(state), runId],
          )
          const delaySec = Math.max(0, step.backoff(attempt))
          await this.queue.dispatchLater(delaySec, this.advanceJob, { runId })
          return null
        }
        // Terminal — journal the failure, mark compensating, kick off
        // compensation. The compensate handler walks back from the
        // step BEFORE this one (no compensator for the step that
        // just failed; there's nothing to roll back since the work
        // didn't commit).
        await tx.execute(
          `INSERT INTO "strav_workflow_journal"
             (id, run_id, step_name, status, result, error, attempts, completed_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'failed', NULL, $4, $5, now(), now(), now())`,
          [ulid(), runId, step.name, message, attempt],
        )
        await tx.execute(
          `UPDATE "strav_workflow_runs"
             SET status = 'compensating', state = $1::jsonb, error = $2, updated_at = now()
           WHERE id = $3`,
          [JSON.stringify(state), message, runId],
        )
        await this.queue.dispatch(this.compensateJob, { runId })
        return null
      }
    })

    // If the step succeeded (or was already journaled), re-enter to
    // advance the next one. We do this OUTSIDE the original
    // transaction so each step holds the row lock for the minimum
    // necessary window — important when steps make external API
    // calls that can be slow.
    if (workflow?.status === 'continue') {
      await this.queue.dispatch(this.advanceJob, { runId })
    }
  }

  /**
   * Compensate handler. Walks the journal in reverse, calling each
   * registered compensator. Compensators that throw are logged but
   * don't halt the rollback — the rest still run. When the walk
   * finishes the run lands in `failed`.
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
      const state = parseJson(row.state) as { results: Record<string, unknown> }
      const input = parseJson(row.input) as Record<string, unknown>

      const journal = await tx.query<JournalRow>(
        `SELECT id, run_id, step_name, status, result, error, attempts, completed_at
         FROM "strav_workflow_journal" WHERE run_id = $1 ORDER BY completed_at ASC`,
        [runId],
      )
      // Build an ordered list of successfully-completed step names so we
      // can walk back through `wf.steps` in declaration order and find
      // each compensator. Failed-step rows are skipped — they hold no
      // committed work to roll back.
      const completedNames = new Set(
        journal.filter((j) => j.status === 'completed').map((j) => j.step_name),
      )
      const stepsByName = new Map<string, DurableStep>(wf.steps.map((s) => [s.name, s]))

      for (const name of [...completedNames].reverse()) {
        const step = stepsByName.get(name)
        if (!step?.compensate) continue
        try {
          await step.compensate({
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

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async markCompleted(
    tx: Database | { execute: (s: string, p: unknown[]) => Promise<number> },
    runId: string,
    results: Record<string, unknown>,
  ): Promise<void> {
    await tx.execute(
      `UPDATE "strav_workflow_runs"
         SET status = 'completed', state = $1::jsonb, result = $2::jsonb, updated_at = now()
       WHERE id = $3`,
      [
        JSON.stringify({ results, stepAttempts: {} }),
        JSON.stringify(results),
        runId,
      ],
    )
  }

  private async advanceCursor(
    tx: { execute: (s: string, p: unknown[]) => Promise<number> },
    runId: string,
    nextStep: number,
    state: { results: Record<string, unknown>; stepAttempts: Record<string, number> },
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

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function toSnapshot(row: RunRow): RunSnapshot {
  const state = parseJson(row.state) as { results?: Record<string, unknown> } | null
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
