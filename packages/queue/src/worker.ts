/**
 * `Worker` — consumer side of `DatabaseQueue`.
 *
 * The poll loop:
 *   1. Inside one transaction: `SELECT … FOR UPDATE SKIP LOCKED` claims
 *      one available row (`available_at <= now() AND reserved_at IS
 *      NULL`), then `UPDATE` increments `attempts` + sets
 *      `reserved_at = now()`. SKIP LOCKED lets multiple Worker
 *      instances poll the same queue concurrently without picking
 *      the same row.
 *   2. The transaction COMMITs — the claim is durable. The row stays
 *      reserved until the result handling clears it.
 *   3. The Worker constructs the Job via the container and runs
 *      `handle(ctx)` with a per-attempt timeout (driven by
 *      `AbortSignal.timeout(...)` — handlers that loop should check
 *      `ctx.signal.aborted`).
 *   4. On success: DELETE the row.
 *   5. On failure: if `attempts < max_attempts`, schedule a retry —
 *      `UPDATE` sets `available_at = now() + backoff` + clears
 *      `reserved_at`. Otherwise terminal — INSERT into
 *      `strav_failed_jobs` + DELETE from `strav_jobs`, both in a
 *      single transaction so the move is atomic. The `queue:retry` /
 *      `queue:flush` console commands that act on the failed-jobs
 *      table land with `@strav/cli` in M4.
 *
 * Backoff: default exponential with ±25% jitter, capped at 300s. Per-
 * job override via `static backoff(attempt)`; per-Worker override
 * via `defaultBackoff`.
 *
 * Graceful shutdown: callers pass an `AbortSignal` to `run()`. The
 * loop checks `signal.aborted` between iterations + before the next
 * sleep, so the worker exits cleanly within one poll-interval window
 * of the abort.
 */

import type { Database } from '@strav/database'
import { type Container, type Logger, ulid } from '@strav/kernel'
import type { JobContext, JobFailedContext } from './job.ts'
import type { JobRegistry } from './job_registry.ts'

export interface WorkerOptions {
  /** Postgres pool used for claim + result handling. */
  db: Database
  /** Job registry — used to resolve `job_name` → `JobClass`. */
  registry: JobRegistry
  /** Container used to construct Job instances (resolves `@inject()` deps). */
  container: Container
  /** Worker logger — used for control-plane events (claim, retry, fail). Default: no-op. */
  logger?: Logger
  /** Queue names this Worker polls. Default `['default']`. */
  queues?: readonly string[]
  /** Milliseconds to sleep when a poll finds no available rows. Default 1000. */
  pollInterval?: number
  /** Per-attempt timeout (seconds) when the JobClass doesn't override it. Default 60. */
  timeoutSeconds?: number
  /** `max_attempts` fallback when neither the JobClass nor the row sets it. Default 3. */
  defaultAttempts?: number
  /** Backoff fallback when the JobClass doesn't override `backoff`. Default: exponential + jitter. */
  defaultBackoff?: (attempt: number) => number
}

/** Outcome of `processOne()` — useful for tests + one-shot runs. */
export type JobResult =
  | { status: 'completed'; jobId: string; jobName: string; attempts: number }
  | { status: 'retried'; jobId: string; jobName: string; attempts: number; nextAt: Date }
  | { status: 'failed'; jobId: string; jobName: string; attempts: number; error: unknown }

/** Row shape pulled from `strav_jobs` during claim. */
interface JobRow {
  id: string
  queue: string
  job_name: string
  payload: unknown
  attempts: number
  max_attempts: number
}

export class Worker {
  private readonly db: Database
  private readonly registry: JobRegistry
  private readonly container: Container
  private readonly logger: Logger
  private readonly queues: readonly string[]
  private readonly pollInterval: number
  private readonly timeoutSeconds: number
  private readonly defaultAttempts: number
  private readonly defaultBackoff: (attempt: number) => number

  constructor(opts: WorkerOptions) {
    this.db = opts.db
    this.registry = opts.registry
    this.container = opts.container
    this.logger = opts.logger ?? createNoopLogger()
    this.queues = opts.queues ?? ['default']
    this.pollInterval = opts.pollInterval ?? 1000
    this.timeoutSeconds = opts.timeoutSeconds ?? 60
    this.defaultAttempts = opts.defaultAttempts ?? 3
    this.defaultBackoff = opts.defaultBackoff ?? exponentialBackoff
  }

  /**
   * Process one available job. Returns `null` when the queue has nothing
   * to claim, otherwise a `JobResult` describing the outcome. Tests +
   * one-shot CLI invocations use this directly; `run()` calls it in
   * a loop.
   */
  async processOne(): Promise<JobResult | null> {
    const row = await this.claim()
    if (!row) return null

    const jobClass = this.registry.get(row.job_name)
    if (!jobClass) {
      // Unknown job_name → can't deserialize. Delete the row + log —
      // leaving it would block the queue forever (every poll would
      // re-claim + fail). Apps that need to recover unknown rows
      // should snapshot the queue before changing job_names.
      this.logger.error('Worker: unknown job_name, deleting row', {
        jobId: row.id,
        jobName: row.job_name,
      })
      await this.deleteRow(row.id)
      return {
        status: 'failed',
        jobId: row.id,
        jobName: row.job_name,
        attempts: row.attempts,
        error: new Error(`unknown job_name "${row.job_name}"`),
      }
    }

    const job = this.container.make(jobClass)
    const timeoutMs = (jobClass.timeout ?? this.timeoutSeconds) * 1000
    const signal = AbortSignal.timeout(timeoutMs)

    const ctx: JobContext = {
      jobId: row.id,
      attempt: row.attempts,
      payload: row.payload,
      signal,
      log: this.logger,
    }

    try {
      await job.handle(ctx)
      await this.deleteRow(row.id)
      return {
        status: 'completed',
        jobId: row.id,
        jobName: row.job_name,
        attempts: row.attempts,
      }
    } catch (error) {
      // Best-effort failed() hook — runs on every failed attempt
      // (intermediate + terminal). A throw here is logged but doesn't
      // change the retry decision; the hook is a notification, not a
      // control point.
      if (job.failed) {
        const failedCtx: JobFailedContext = { ...ctx, error }
        try {
          await job.failed(failedCtx)
        } catch (hookError) {
          this.logger.error('Worker: failed() hook threw', {
            jobId: row.id,
            jobName: row.job_name,
            error: hookError,
          })
        }
      }

      const maxAttempts = jobClass.maxAttempts ?? row.max_attempts ?? this.defaultAttempts
      if (row.attempts >= maxAttempts) {
        // Terminal — atomically move the row to `strav_failed_jobs`
        // so apps can triage what blew up. INSERT into the dead-letter
        // table + DELETE from strav_jobs share one transaction so we
        // can't end up with a row in both (or neither) on a Postgres
        // wobble mid-move.
        this.logger.error('Worker: job terminal failure', {
          jobId: row.id,
          jobName: row.job_name,
          attempts: row.attempts,
        })
        await this.moveToFailed(row, error)
        return {
          status: 'failed',
          jobId: row.id,
          jobName: row.job_name,
          attempts: row.attempts,
          error,
        }
      }

      const backoff = jobClass.backoff ?? this.defaultBackoff
      const delaySeconds = Math.max(0, backoff(row.attempts))
      await this.scheduleRetry(row.id, delaySeconds)
      this.logger.warn('Worker: job retry scheduled', {
        jobId: row.id,
        jobName: row.job_name,
        attempts: row.attempts,
        delaySeconds,
      })
      return {
        status: 'retried',
        jobId: row.id,
        jobName: row.job_name,
        attempts: row.attempts,
        nextAt: new Date(Date.now() + delaySeconds * 1000),
      }
    }
  }

  /**
   * Run the poll loop until `signal` aborts. Each iteration calls
   * `processOne()`; an empty poll triggers a sleep of `pollInterval`
   * ms. The sleep is abort-aware — `signal.abort()` exits the loop
   * within one tick rather than waiting out the full interval.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.processOne()
        if (result === null) {
          await sleep(this.pollInterval, signal)
        }
      } catch (loopError) {
        // Polling itself failed (network blip, DB restart). Log + sleep
        // before retrying — without the sleep, a persistent failure
        // would burn CPU.
        this.logger.error('Worker: poll iteration failed', { error: loopError })
        await sleep(this.pollInterval, signal)
      }
    }
  }

  /**
   * Atomically claim one row: SELECT … FOR UPDATE SKIP LOCKED + UPDATE
   * to mark reserved + increment attempts. Single transaction so the
   * claim is durable + safe against concurrent Workers.
   */
  private async claim(): Promise<JobRow | null> {
    return this.db.transaction(async (tx) => {
      const row = await tx.queryOne<JobRow>(
        `SELECT id, queue, job_name, payload, attempts, max_attempts
         FROM "strav_jobs"
         WHERE queue = ANY($1::text[])
           AND available_at <= now()
           AND reserved_at IS NULL
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [this.queues],
      )
      if (!row) return null
      await tx.execute(
        `UPDATE "strav_jobs"
         SET reserved_at = now(), attempts = attempts + 1, updated_at = now()
         WHERE id = $1`,
        [row.id],
      )
      // Reflect the increment in the returned row so the caller's
      // attempt counter matches what's in the DB.
      return { ...row, attempts: Number(row.attempts) + 1 }
    })
  }

  private async deleteRow(id: string): Promise<void> {
    await this.db.execute(`DELETE FROM "strav_jobs" WHERE id = $1`, [id])
  }

  /**
   * Atomically move a terminal-failure row to `strav_failed_jobs`.
   * INSERT + DELETE in one transaction so we can't half-move on a
   * Postgres wobble. The `exception` column stores
   * `error.stack ?? String(error)` — full stack when available, the
   * stringified value otherwise (some libraries throw plain strings).
   */
  private async moveToFailed(row: JobRow, error: unknown): Promise<void> {
    const exception =
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO "strav_failed_jobs"
           (id, queue, job_name, payload, exception, attempts, failed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, now(), now(), now())`,
        [ulid(), row.queue, row.job_name, JSON.stringify(row.payload), exception, row.attempts],
      )
      await tx.execute(`DELETE FROM "strav_jobs" WHERE id = $1`, [row.id])
    })
  }

  private async scheduleRetry(id: string, delaySeconds: number): Promise<void> {
    await this.db.execute(
      `UPDATE "strav_jobs"
       SET available_at = now() + interval '${delaySeconds} seconds',
           reserved_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [id],
    )
  }
}

/**
 * Default backoff — exponential with ±25% jitter, capped at 5 minutes.
 *
 *   attempt=1 → ~2s     (base 2)
 *   attempt=2 → ~4s     (base 4)
 *   attempt=3 → ~8s     (base 8)
 *   attempt=4 → ~16s    (base 16)
 *   attempt=5 → ~32s
 *   …
 *   attempt=9+ → ~300s  (clamped)
 *
 * Jitter prevents thundering-herd retries when many jobs fail at
 * the same time (e.g. a downstream service blip).
 */
function exponentialBackoff(attempt: number): number {
  const base = Math.min(300, 2 ** attempt)
  const jitter = (Math.random() * 2 - 1) * base * 0.25
  return Math.max(1, Math.round(base + jitter))
}

/** Abort-aware sleep. Returns when either the timer fires or the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** No-op Logger — same shape as the one in DatabaseQueue / SyncQueue. */
function createNoopLogger(): Logger {
  const noop = () => undefined
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    child: () => createNoopLogger(),
  } as unknown as Logger
}
