/**
 * `Queue` — the contract every backend implements.
 *
 * V1 ships two: `SyncQueue` (in-process, no persistence — for tests +
 * single-process dev) and `DatabaseQueue` (Postgres-backed, the
 * production driver). Both implement this interface; apps depend on
 * the abstract `Queue` symbol via DI.
 *
 * Method semantics:
 *   - `dispatch(JobClass, payload, opts?)` — enqueue for a Worker to
 *     pick up. Returns the assigned `jobId` (ULID).
 *   - `dispatchLater(at, JobClass, payload, opts?)` — same as dispatch
 *     but the row isn't picked up until `at`. `at` is either a `Date`
 *     (absolute) or a number of seconds from now (relative).
 *   - `dispatchSync(JobClass, payload)` — instantiate + run `handle()`
 *     synchronously in the caller's process. No persistence, no
 *     retries, no Worker required. Useful for tests, for dev mode,
 *     and for callers that genuinely want the work done inline (rare
 *     in production — most jobs exist precisely to defer work).
 */

import type { JobClass, PayloadOf } from './job.ts'

export interface DispatchOptions {
  /** Named queue to dispatch onto. Default: the JobClass's `static queue` or `'default'`. */
  queue?: string
  /**
   * Override total attempts (including the first). Default: the
   * JobClass's `static maxAttempts`, or the driver default (typically 3).
   */
  attempts?: number
}

export interface DispatchLaterOptions extends DispatchOptions {
  // No additional options today; the slot exists so future drivers can
  // grow it (e.g. `priority` or `deduplicationKey`) without breaking
  // the call sites.
}

export interface Queue {
  /** Enqueue immediately. Returns the assigned job id (ULID). */
  dispatch<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    opts?: DispatchOptions,
  ): Promise<string>

  /**
   * Enqueue with a delay. `at` is either a `Date` (absolute wall-clock
   * time) or a positive number of seconds from now. Returns the
   * assigned job id (ULID).
   *
   * `Date` values in the past are clamped to "now" — i.e. the job
   * becomes immediately eligible. Negative numbers throw.
   */
  dispatchLater<TJob extends JobClass>(
    at: Date | number,
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    opts?: DispatchLaterOptions,
  ): Promise<string>

  /**
   * Run the job synchronously in the caller's process. No persistence,
   * no retries — if `handle()` throws, the throw propagates. Returns
   * when `handle()` resolves.
   */
  dispatchSync<TJob extends JobClass>(jobClass: TJob, payload: PayloadOf<TJob>): Promise<void>
}
