/**
 * `Scheduler` — recurring job dispatch on a cron cadence.
 *
 * Two surfaces:
 *   - `.schedule(opts)` registers an entry (`{ job, cron, name?,
 *     payload?, oneServer? }`). Returns `this` for chaining.
 *   - `.tick(now)` processes every registered entry whose cron matches
 *     `now`. Dispatches via the wired `Queue`. Exposed for tests +
 *     one-shot CLI use.
 *   - `.run(signal)` is the long-running loop — calls `tick()` at each
 *     minute boundary, sleeps abort-aware between ticks.
 *
 * `oneServer: true` entries use `TenantManager.withLock` to acquire a
 * fleet-wide advisory lock named after the entry. Inside the lock the
 * dispatcher checks `strav_scheduler_runs.last_run_at` — if the
 * current tick boundary already has a run recorded, this server skips
 * (another server won). Otherwise dispatch + UPSERT atomically.
 *
 * `withLock` is built on `UnitOfWork.run`, which means
 * `DatabaseQueue.dispatch` inside it auto-routes through the same
 * transaction — the queue row INSERT + the run-tracking UPSERT commit
 * together. A throw before COMMIT drops both. Exactly the
 * queue-until-commit semantic from M2.
 *
 * Cron matching is UTC-based (see {@link CronExpression}). Apps that
 * want local-time scheduling shift their schedule expressions; the
 * Scheduler doesn't take a timezone option.
 */

import type { TenantManager } from '@strav/database'
import { type Logger, ulid } from '@strav/kernel'
import type { CronExpression } from './cron.ts'
import type { JobClass } from './job.ts'
import type { Queue } from './queue.ts'

export interface ScheduleOptions {
  /** Job to dispatch when the cron matches. */
  job: JobClass
  /** Payload handed to the Job. Default `undefined` → empty payload. */
  payload?: unknown
  /** Cron expression that gates the dispatch. */
  cron: CronExpression
  /**
   * Identifier used for the advisory lock key + the
   * `strav_scheduler_runs` row. Defaults to `job.jobName`.
   * Specify when one job class is scheduled multiple times with
   * different cadences / payloads, so each has its own lock + row.
   */
  name?: string
  /**
   * When `true`, only one server in the fleet dispatches per tick
   * (advisory lock + run-tracking row). When `false` (default), every
   * server dispatches independently — fine for jobs whose work is
   * itself idempotent or which want fan-out semantics.
   */
  oneServer?: boolean
}

export interface SchedulerOptions {
  /** Queue used to dispatch each entry's job. */
  queue: Queue
  /**
   * TenantManager — used for its `withLock` + UoW combo on
   * `oneServer` entries. `Scheduler` doesn't itself do tenancy; this
   * is the most ergonomic primitive for "advisory lock + transaction
   * + ambient ALS so dispatch joins the same tx."
   */
  tenants: TenantManager
  /**
   * Optional fallback executor used when an `oneServer: false` entry's
   * dispatch raises. Only used to log the failure; the Queue itself
   * already routes the SQL. Default: no-op logger.
   */
  logger?: Logger
}

interface ScheduledEntry {
  name: string
  cron: CronExpression
  job: JobClass
  payload: unknown
  oneServer: boolean
}

export class Scheduler {
  private readonly queue: Queue
  private readonly tenants: TenantManager
  private readonly logger: Logger
  private readonly entries: ScheduledEntry[] = []

  constructor(opts: SchedulerOptions) {
    this.queue = opts.queue
    this.tenants = opts.tenants
    this.logger = opts.logger ?? createNoopLogger()
  }

  /** Register a recurring dispatch. Returns `this` for chaining. */
  schedule(options: ScheduleOptions): this {
    this.entries.push({
      name: options.name ?? options.job.jobName,
      cron: options.cron,
      job: options.job,
      payload: options.payload,
      oneServer: options.oneServer ?? false,
    })
    return this
  }

  /** Every registered entry — exposed for inspection / tests. */
  all(): readonly ScheduledEntry[] {
    return [...this.entries]
  }

  /**
   * Process every entry against `now`. The tick boundary is `now`
   * floored to the start of its minute (seconds + millis cleared) —
   * cron matches against that, and `oneServer` run-tracking writes
   * that value into `strav_scheduler_runs.last_run_at`.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const boundary = floorToMinute(now)
    for (const entry of this.entries) {
      if (!entry.cron.matches(boundary)) continue
      try {
        if (entry.oneServer) {
          await this.dispatchOneServer(entry, boundary)
        } else {
          await this.queue.dispatch(entry.job, entry.payload as never)
        }
      } catch (error) {
        this.logger.error('Scheduler: dispatch failed', {
          name: entry.name,
          jobName: entry.job.jobName,
          error,
        })
      }
    }
  }

  /**
   * Run the minute-tick loop until `signal` aborts. Each iteration
   * sleeps until the next minute boundary, then calls `tick()`. The
   * sleep is abort-aware — `signal.abort()` returns within one tick
   * rather than waiting out the minute.
   *
   * On the FIRST iteration, sleeps to the next minute boundary
   * BEFORE the first tick — so callers see one full minute pass
   * between `run()` start and the first dispatch. (Calling `tick()`
   * explicitly before `run()` is the way to dispatch immediately.)
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = new Date()
      const nextBoundary = nextMinuteBoundary(now)
      const sleepMs = Math.max(0, nextBoundary.getTime() - now.getTime())
      await sleep(sleepMs, signal)
      if (signal.aborted) return
      try {
        await this.tick(nextBoundary)
      } catch (loopError) {
        this.logger.error('Scheduler: tick iteration failed', { error: loopError })
      }
    }
  }

  private async dispatchOneServer(entry: ScheduledEntry, tickBoundary: Date): Promise<void> {
    await this.tenants.withLock(`scheduler:${entry.name}`, async (tx) => {
      const last = await tx.queryOne<{ last_run_at: Date }>(
        `SELECT last_run_at FROM "strav_scheduler_runs" WHERE name = $1`,
        [entry.name],
      )
      // The lock serializes the read+write window — if another server
      // already recorded this tick boundary, skip cleanly.
      if (last !== null && last.last_run_at.getTime() >= tickBoundary.getTime()) {
        return
      }
      // Inside withLock's UoW, the dispatch routes through the ambient
      // tx — the queue row INSERT + the run-tracking UPSERT commit
      // atomically. If anything throws, both roll back.
      await this.queue.dispatch(entry.job, entry.payload as never)
      await tx.execute(
        `INSERT INTO "strav_scheduler_runs" (id, name, last_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (name) DO UPDATE
           SET last_run_at = EXCLUDED.last_run_at, updated_at = now()`,
        [ulid(), entry.name, tickBoundary],
      )
    })
  }
}

/** Floor a Date to the start of its minute (seconds + millis cleared). */
function floorToMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      0,
      0,
    ),
  )
}

/** Next-minute boundary strictly after `date`. */
function nextMinuteBoundary(date: Date): Date {
  const floor = floorToMinute(date)
  return new Date(floor.getTime() + 60_000)
}

/** Abort-aware sleep. */
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

/** No-op Logger — same shape as the ones in DatabaseQueue / Worker. */
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
