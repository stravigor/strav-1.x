/**
 * `DatabaseQueue` — Postgres-backed `Queue` driver.
 *
 * Persists each `dispatch` / `dispatchLater` as a `_strav_jobs` row;
 * Workers (next M3 slice) `SELECT FOR UPDATE SKIP LOCKED` to claim
 * available rows and run `handle()`.
 *
 * **Queue-until-commit semantics.** When `dispatch()` is called inside
 * a `UnitOfWork.run(...)` or `TenantManager.withTenant(...)` scope, the
 * driver routes the INSERT through the ambient transaction's executor
 * (read from `transactionalStorage`). The new row commits + rolls back
 * atomically with the surrounding transaction:
 *
 *   - If the transaction COMMITs, the queue row is visible to Workers.
 *     The dispatched job runs.
 *   - If the transaction ROLLBACKs, the row never existed. The job is
 *     dropped.
 *
 * This is exactly the spec's M3 spike ("flush queue on commit; drop
 * on rollback") — Postgres's transactional atomicity gives us the
 * semantic for free; no deferred-callback machinery needed.
 *
 * Outside a transactional scope, `dispatch` writes against
 * `this.db` directly (auto-commit).
 *
 * `dispatchSync` bypasses persistence entirely — instantiates the Job
 * via the container and runs `handle()` in-process, just like
 * `SyncQueue.dispatchSync`. The caller's session continues without a
 * Worker ever seeing the work.
 */

import {
  currentTransactionalContext,
  type Database,
  type DatabaseExecutor,
  type PostgresDatabase,
} from '@strav/database'
import { type Container, type Logger, ulid } from '@strav/kernel'
import type { JobClass, JobContext, PayloadOf } from './job.ts'
import { jobSchema } from './job_schema.ts'
import type { DispatchLaterOptions, DispatchOptions, Queue } from './queue.ts'

export interface DatabaseQueueOptions {
  /** Postgres pool used for INSERTs outside an ambient transaction. */
  db: PostgresDatabase | Database
  /**
   * Container used to construct Job instances for `dispatchSync`. The
   * Worker (separate slice) also goes through the container, so the
   * same `@inject()`-driven wiring resolves consistently.
   */
  container: Container
  /** Optional Logger attached to `dispatchSync` `JobContext.log`. Default: no-op. */
  logger?: Logger
  /** Default `max_attempts` when neither the JobClass nor `DispatchOptions` specifies one. Default `3`. */
  defaultAttempts?: number
  /** Default queue name when neither the JobClass nor `DispatchOptions` specifies one. Default `'default'`. */
  defaultQueue?: string
}

export class DatabaseQueue implements Queue {
  private readonly db: Database
  private readonly container: Container
  private readonly logger: Logger
  private readonly defaultAttempts: number
  private readonly defaultQueue: string

  constructor(opts: DatabaseQueueOptions) {
    this.db = opts.db
    this.container = opts.container
    this.logger = opts.logger ?? createNoopLogger()
    this.defaultAttempts = opts.defaultAttempts ?? 3
    this.defaultQueue = opts.defaultQueue ?? 'default'
  }

  async dispatch<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    opts?: DispatchOptions,
  ): Promise<string> {
    return this.insertJob(jobClass, payload, /* delaySeconds */ 0, opts)
  }

  async dispatchLater<TJob extends JobClass>(
    at: Date | number,
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    opts?: DispatchLaterOptions,
  ): Promise<string> {
    const delaySeconds = computeDelaySeconds(at)
    return this.insertJob(jobClass, payload, delaySeconds, opts)
  }

  async dispatchSync<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
  ): Promise<void> {
    const jobId = ulid()
    const job = this.container.make(jobClass)
    const ctx: JobContext = {
      jobId,
      attempt: 1,
      payload,
      // SyncQueue parity — dispatchSync runs to completion in one tick;
      // a never-aborted signal keeps handlers written against the
      // production contract working unchanged.
      signal: new AbortController().signal,
      log: this.logger,
    }
    await job.handle(ctx)
  }

  /**
   * Single INSERT path shared by `dispatch` + `dispatchLater`. Reads
   * the ambient transactional context — when present, the INSERT
   * routes through `ctx.tx` so the row is part of the surrounding
   * transaction's atomicity guarantee.
   */
  private async insertJob<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    delaySeconds: number,
    opts: DispatchOptions | undefined,
  ): Promise<string> {
    const jobId = ulid()
    const queue = opts?.queue ?? jobClass.queue ?? this.defaultQueue
    const maxAttempts = opts?.attempts ?? jobClass.maxAttempts ?? this.defaultAttempts

    const executor: DatabaseExecutor = currentTransactionalContext()?.tx ?? this.db
    // `available_at` is computed in Postgres so the queue's notion of
    // "now" is the DB clock — the only clock the Worker reads.
    // Mixing wall-clock from the dispatcher with DB-clock from the
    // Worker invites skew bugs.
    const availableAtFragment =
      delaySeconds > 0 ? `now() + interval '${delaySeconds} seconds'` : 'now()'
    await executor.execute(
      `INSERT INTO ${quoteIdent(jobSchema.name)} (
        "id", "queue", "job_name", "payload", "attempts", "max_attempts", "available_at", "created_at", "updated_at"
      ) VALUES (
        $1, $2, $3, $4::jsonb, 0, $5, ${availableAtFragment}, now(), now()
      )`,
      // `payload` defaults to `{}` for jobs that don't take input — without
      // this fallback `JSON.stringify(undefined)` yields `undefined`, which
      // arrives as NULL and trips the column's NOT NULL constraint.
      [jobId, queue, jobClass.jobName, JSON.stringify(payload ?? {}), maxAttempts],
    )
    return jobId
  }
}

/** Normalize `at` (Date | seconds-from-now) → seconds-from-now ≥ 0. */
function computeDelaySeconds(at: Date | number): number {
  if (typeof at === 'number') {
    if (at < 0) {
      throw new Error(`DatabaseQueue.dispatchLater: delay must be non-negative, got ${at}.`)
    }
    return at
  }
  // `at` is a Date — past values clamp to 0 (immediately available).
  const deltaMs = at.getTime() - Date.now()
  return Math.max(0, Math.ceil(deltaMs / 1000))
}

/** Single-quote-aware identifier quoter for the schema table name. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Bare Logger that drops every call — same shape as SyncQueue's. */
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
