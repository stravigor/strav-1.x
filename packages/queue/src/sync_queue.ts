/**
 * `SyncQueue` — in-process synchronous Queue driver.
 *
 * Instantiates the Job via the container (so `@inject()` resolves
 * dependencies the same way the real Worker would), builds a
 * `JobContext`, runs `handle(ctx)`. No persistence, no retries — if
 * the handler throws, the throw propagates to the dispatcher.
 *
 * Use cases:
 *   - **Tests** — drive a job end-to-end without standing up a
 *     `DatabaseQueue` + Worker.
 *   - **Single-process dev** — flatten the Queue → Worker hop so
 *     `bun dev` shows job output inline.
 *   - **Inline-by-design** — rare in production, but callers that
 *     genuinely want sync execution (e.g. an importer that's already
 *     in a transaction) call `dispatchSync` directly.
 *
 * The non-sync methods (`dispatch` / `dispatchLater`) on this driver
 * also run the work synchronously — they exist so the same code path
 * works in both sync-only test setups and async-Worker production
 * setups. `dispatchLater`'s delay is ignored under SyncQueue; the work
 * runs immediately.
 */

import { type Container, type Logger, ulid } from '@strav/kernel'
import type { JobClass, JobContext, PayloadOf } from './job.ts'
import type { DispatchLaterOptions, DispatchOptions, Queue } from './queue.ts'

export interface SyncQueueOptions {
  /**
   * Container used to construct Job instances. `make(JobClass)` builds
   * via `@inject()` metadata, so subclasses with constructor deps get
   * the same wiring the production Worker provides.
   */
  container: Container
  /**
   * Optional Logger to attach to every `JobContext.log`. When omitted,
   * a no-op logger is used — useful in tests where log noise is
   * unwelcome.
   */
  logger?: Logger
}

export class SyncQueue implements Queue {
  private readonly container: Container
  private readonly logger: Logger

  constructor(opts: SyncQueueOptions) {
    this.container = opts.container
    this.logger = opts.logger ?? createNoopLogger()
  }

  async dispatch<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    _opts?: DispatchOptions,
  ): Promise<string> {
    const jobId = ulid()
    await this.run(jobId, jobClass, payload)
    return jobId
  }

  async dispatchLater<TJob extends JobClass>(
    at: Date | number,
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    _opts?: DispatchLaterOptions,
  ): Promise<string> {
    // Validate the delay even though we don't honor it — same contract
    // surface as the production driver, so callers can't accidentally
    // pass a negative delay that "works" under SyncQueue and fails on
    // DatabaseQueue.
    if (typeof at === 'number' && at < 0) {
      throw new Error(`SyncQueue.dispatchLater: delay must be non-negative, got ${at}.`)
    }
    return this.dispatch(jobClass, payload)
  }

  async dispatchSync<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
  ): Promise<void> {
    await this.run(ulid(), jobClass, payload)
  }

  private async run<TJob extends JobClass>(
    jobId: string,
    jobClass: TJob,
    payload: PayloadOf<TJob>,
  ): Promise<void> {
    const job = this.container.make(jobClass)
    const ctx: JobContext = {
      jobId,
      attempt: 1,
      payload,
      // SyncQueue runs to completion in one tick — abort isn't a thing
      // here. We hand out a never-aborted signal so handlers written
      // against the production contract don't need a separate code
      // path.
      signal: new AbortController().signal,
      log: this.logger,
    }
    await job.handle(ctx)
  }
}

/**
 * Bare Logger that drops every call. Avoids pulling in the full
 * LoggerProvider when callers just want SyncQueue in tests.
 */
function createNoopLogger(): Logger {
  const noop = () => undefined
  // The Logger contract is wider; the few methods downstream code may
  // call are stubbed. Cast keeps the type signature honest at the
  // boundary — Logger's full surface includes `child()` etc., which a
  // future caller could exercise.
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
