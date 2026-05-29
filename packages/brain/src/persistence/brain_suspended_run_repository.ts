/**
 * `BrainSuspendedRunRepository` — data-access for paused agentic
 * runs.
 *
 * Adds two domain helpers on top of generic CRUD:
 *
 *   - `markResumed(id)` / `markCancelled(id)` — flip the status
 *     enum once the human approval has been processed. Apps can
 *     filter `listPending(...)` on `status = 'pending'` to see
 *     what's still waiting.
 *   - `listPending(filter?)` — paginate pending runs, optionally
 *     filtered by `user_id` or `thread_id`.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase value import for @inject().
import { PostgresDatabase, Repository } from '@strav/database'
// biome-ignore lint/style/useImportType: EventBus value import for @inject().
import { EventBus, inject } from '@strav/kernel'
import { BrainSuspendedRun, type BrainSuspendedRunStatus } from './brain_suspended_run.ts'
import { brainSuspendedRunSchema } from './schema/brain_suspended_run_schema.ts'

export interface ListPendingOptions {
  /** Filter by app-defined user — useful when an app has per-user approval queues. */
  userId?: string
  /** Filter by the linked thread (when set). */
  threadId?: string
  /** Pagination — defaults to 50. */
  limit?: number
  offset?: number
}

@inject()
export class BrainSuspendedRunRepository extends Repository<BrainSuspendedRun> {
  static override readonly schema = brainSuspendedRunSchema
  static override readonly model = BrainSuspendedRun

  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor for @inject() metadata emission.
  constructor(db: PostgresDatabase, events: EventBus) {
    super(db, events)
  }

  /** Flip status to `resumed` after `brain.resumeTools(state, ...)` succeeds. */
  async markResumed(run: BrainSuspendedRun): Promise<BrainSuspendedRun> {
    return this.markStatus(run, 'resumed')
  }

  /** Flip status to `cancelled` when the human approver declined the run. */
  async markCancelled(run: BrainSuspendedRun): Promise<BrainSuspendedRun> {
    return this.markStatus(run, 'cancelled')
  }

  /** List pending runs, newest-first by default. */
  async listPending(opts: ListPendingOptions = {}): Promise<BrainSuspendedRun[]> {
    let q = this.query().where('status', 'pending')
    if (opts.userId !== undefined) q = q.where('user_id', opts.userId)
    if (opts.threadId !== undefined) q = q.where('thread_id', opts.threadId)
    q = q.orderBy('created_at', 'desc').limit(opts.limit ?? 50)
    if (opts.offset !== undefined) q = q.offset(opts.offset)
    return q.get()
  }

  private markStatus(
    run: BrainSuspendedRun,
    status: BrainSuspendedRunStatus,
  ): Promise<BrainSuspendedRun> {
    return this.update(run, { status } as Partial<BrainSuspendedRun>)
  }
}
