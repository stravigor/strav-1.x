/**
 * `BrainThreadRepository` — data-access object for `BrainThread`.
 *
 * Adds thread-specific helpers on top of the generic CRUD surface:
 *
 *   - `listForUser(userId, opts?)` — paginate threads for a user,
 *     ordered by `updated_at DESC` (most-recently-active first).
 *   - `updateResponseId(thread, id)` — small helper that wraps the
 *     `update()` call apps make when threading
 *     `previousResponseId` forward.
 *
 * Multitenancy: every query auto-scopes to the current tenant via
 * RLS when wrapped in `tenants.withTenant(...)`. No tenant filter
 * shows up in this code — the database enforces isolation.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase needs to be a value import — the @inject() decorator below resolves the constructor param via reflect-metadata, which requires the runtime class reference.
import { PostgresDatabase, Repository } from '@strav/database'
// biome-ignore lint/style/useImportType: EventBus has the same constraint as PostgresDatabase.
import { EventBus, inject } from '@strav/kernel'
import { BrainThread } from './brain_thread.ts'
import { brainThreadSchema } from './schema/brain_thread_schema.ts'

export interface ListThreadsOptions {
  /** Pagination — defaults to 50. */
  limit?: number
  offset?: number
}

@inject()
export class BrainThreadRepository extends Repository<BrainThread> {
  static override readonly schema = brainThreadSchema
  static override readonly model = BrainThread

  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor forces TypeScript to emit `design:paramtypes` metadata on the subclass for the @inject() decorator above.
  constructor(db: PostgresDatabase, events: EventBus) {
    super(db, events)
  }

  /**
   * List threads for a given app-defined user, newest-first. Empty
   * `userId` lists every thread visible under RLS — useful for
   * admin views or tenant-wide audits.
   */
  async listForUser(
    userId: string | null,
    opts: ListThreadsOptions = {},
  ): Promise<BrainThread[]> {
    let q = this.query()
    if (userId !== null) q = q.where('user_id', userId)
    q = q.orderBy('updated_at', 'desc').limit(opts.limit ?? 50)
    if (opts.offset !== undefined) q = q.offset(opts.offset)
    return q.get()
  }

  /**
   * Update a thread's `last_response_id`. Wraps `update()` so the
   * standard `updated_at` bump + repository lifecycle events still
   * fire — apps that watch `brain_thread.updated` see the
   * transition.
   */
  async updateResponseId(thread: BrainThread, responseId: string): Promise<BrainThread> {
    return this.update(thread, { last_response_id: responseId } as Partial<BrainThread>)
  }
}
