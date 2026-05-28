/**
 * Shared transactional-context state for `UnitOfWork` + `Repository`.
 *
 * `UnitOfWork.run` opens a Database.transaction and runs the user's
 * callback inside `storage.run({ tx, queue }, ...)`. Repository reads
 * the ambient scope from this ALS:
 *
 *   - `executor(opts)` resolves explicit `opts.tx` first; falls back to
 *     the ambient `tx`; falls back to `this.db`.
 *   - `emit()` queues post-events (`.created` / `.updated` / `.deleted`)
 *     onto `queue` when one exists, so they fire after the user's
 *     callback succeeds but before the implicit COMMIT — listener
 *     throws can still roll back the transaction. Cancelable events
 *     (`.creating` / `.updating` / `.deleting`) ALWAYS fire immediately;
 *     queueing them would defeat their abort-via-throw semantic.
 *
 * Shared by the database package's unit_of_work + orm modules. Apps
 * shouldn't touch this directly — go through `UnitOfWork.run` or
 * Repository's `{ tx? }` parameter.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseExecutor } from '../database.ts'

export interface QueuedEvent {
  /** Full event name — `<resource>.<verb>` (e.g. `user.created`). */
  name: string
  /** Payload value handed to `EventBus.emit`. */
  payload: unknown
}

export interface TransactionalContext {
  /** The transaction-scoped executor — pass into Database calls inside the scope. */
  tx: DatabaseExecutor
  /** Post-event queue. Pushed by Repository.emit, flushed by UnitOfWork.run. */
  queue: QueuedEvent[]
}

/** Module-singleton ALS — survives across the whole package. */
export const transactionalStorage = new AsyncLocalStorage<TransactionalContext | null>()

/** Snapshot of the current transactional scope, or null when outside any UoW. */
export function currentTransactionalContext(): TransactionalContext | null {
  return transactionalStorage.getStore() ?? null
}
