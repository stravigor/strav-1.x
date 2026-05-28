/**
 * `UnitOfWork` — runs a callback inside a transaction with event queuing.
 *
 * The transaction primitive lives on `Database`; this class layers two
 * things on top:
 *
 *   1. **AsyncLocalStorage propagation.** Inside `run(fn)`, every
 *      Repository call automatically uses the transaction-scoped
 *      executor — apps don't have to thread `tx` through every
 *      function call. Explicit `{ tx }` on a Repository call still
 *      wins (overrides the ambient scope).
 *
 *   2. **Post-event queueing.** `<resource>.created` / `.updated` /
 *      `.deleted` events fire AFTER the user's callback returns but
 *      BEFORE the implicit COMMIT, so a listener throw rolls the
 *      transaction back. If the user's callback throws, the queue
 *      drops — no side effects fire for a transaction that didn't
 *      commit. This is the spec's "honest side effects" semantic.
 *
 * Cancelable lifecycle events (`<resource>.creating` / `.updating` /
 * `.deleting`) ALWAYS fire immediately — they're meant to abort the
 * SQL by throwing, which only works if they run before the SQL.
 *
 * Apps either:
 *   - Construct directly: `new UnitOfWork(db, events)` — useful in
 *     tests and bespoke scripts.
 *   - Resolve via the container: a future `UnitOfWorkProvider` will
 *     bind it; for now, apps that want DI register it themselves.
 *
 * Nesting: `UnitOfWork.run` inside another `UnitOfWork.run` opens a
 * NESTED transaction (via the driver's nested-transaction support if
 * any; otherwise just reuses the outer tx). V1 keeps it simple — the
 * inner `run` reuses the outer scope, both queues merge into the
 * outer one. The framework doesn't add savepoint plumbing.
 */

import type { EventBus } from '@strav/kernel'
import type { Database, DatabaseExecutor } from '../database.ts'
import { transactionalStorage } from './context.ts'

export class UnitOfWork {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus | undefined,
  ) {}

  /**
   * Run `fn` inside a transaction. Queued post-events flush after `fn`
   * returns and before the transaction commits — listener throws roll
   * back the transaction. `fn`'s thrown errors propagate; the queue
   * drops and the transaction rolls back.
   *
   * Nested calls reuse the outer scope (one transaction, one queue) —
   * the framework doesn't open savepoints.
   */
  async run<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    const ambient = transactionalStorage.getStore()
    if (ambient) {
      // Nested — reuse the outer transaction + queue. The inner fn
      // gets the same tx; events keep queueing on the outer queue.
      return fn(ambient.tx)
    }

    return this.db.transaction(async (tx) => {
      const queue: { name: string; payload: unknown }[] = []
      return transactionalStorage.run({ tx, queue }, async () => {
        const result = await fn(tx)
        // Flush AFTER fn succeeded, BEFORE the driver commits. A listener
        // throw here propagates → Database.transaction sees the throw →
        // ROLLBACK. So failing side effects roll back the data write.
        if (this.events) {
          for (const event of queue) {
            await this.events.emit(event.name, event.payload)
          }
        }
        return result
      })
    })
  }
}
