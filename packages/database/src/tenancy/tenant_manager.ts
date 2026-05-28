/**
 * `TenantManager` — runs a callback scoped to one tenant.
 *
 * Inside `withTenant(id, fn)`:
 *   1. Open a `UnitOfWork` (transaction + event queue + transactional ALS).
 *   2. `SELECT set_config('app.tenant_id', $1, true)` — the `true` makes
 *      the binding transaction-local, so it auto-clears on COMMIT /
 *      ROLLBACK.
 *   3. Run `fn(tx)` with the transaction-scoped executor. All RLS-
 *      protected queries inside see only this tenant's rows because
 *      the policies emitted by `emitCreateTable` reference
 *      `current_setting('app.tenant_id')`.
 *
 * Because `withTenant` is built on top of `UnitOfWork`, Repository calls
 * inside the callback automatically route through the transaction —
 * no need to thread `tx` through every function call. Post-events
 * (`.created` / `.updated` / `.deleted`) queue and flush before the
 * commit; a thrown listener rolls back. Cancelable `<verb>ing` events
 * still fire immediately so they can abort the SQL.
 *
 * `withoutTenant(fn)` opens a transaction without setting the tenant —
 * RLS policies will see an empty `app.tenant_id` and reject queries.
 * For admin / migration paths, apps wire a `BYPASSRLS` Postgres role
 * at the connection-config layer; the framework's two-role connection
 * config lands as a follow-up tenancy slice.
 *
 * Two `AsyncLocalStorage`s are in play, orthogonal:
 *   - `tenantStorage` — the current tenant ID. Tracked here.
 *   - `transactionalStorage` (from `unit_of_work/context.ts`) — the
 *     current tx + event queue. Tracked by `UnitOfWork`.
 *
 * Nested `withTenant` calls with the SAME tenant pass through; nested
 * calls with a DIFFERENT tenant throw — that's almost always a bug.
 *
 * Deferred to follow-up tenancy slices:
 *   - **Connection-pool role switching.** Today the TenantManager
 *     wraps whatever `Database` it's constructed with; if that's the
 *     app-role pool, queries inside withoutTenant get rejected by RLS.
 *     The followup pairs a bypass-role pool with the manager.
 *   - **Tenant boot-time validation.** The provider doesn't yet check
 *     that the tenant registry table exists in the live DB with the
 *     expected PK type. Misconfiguration surfaces as a Postgres error
 *     at first query for now.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { EventBus } from '@strav/kernel'
import type { Database, DatabaseExecutor } from '../database.ts'
import { UnitOfWork } from '../unit_of_work/unit_of_work.ts'

interface TenantScope {
  tenantId: string
}

/** Module-level ALS for the tenant ID — orthogonal to UoW's transactional ALS. */
const tenantStorage = new AsyncLocalStorage<TenantScope | null>()

export class TenantManager {
  private readonly uow: UnitOfWork

  constructor(db: Database, events?: EventBus) {
    this.uow = new UnitOfWork(db, events)
  }

  /**
   * Run `fn` inside a tenant-scoped transaction. Sets `app.tenant_id` so
   * RLS policies match. Repository calls inside `fn` auto-route through
   * the transaction (via `UnitOfWork`'s transactional ALS) — apps don't
   * need to thread `tx` through.
   *
   * Nested `withTenant(sameId, ...)` passes through (still in scope).
   * Nested `withTenant(differentId, ...)` throws.
   */
  async withTenant<T>(tenantId: string, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    if (!tenantId) {
      throw new Error('TenantManager.withTenant: tenantId must be a non-empty string.')
    }
    const current = tenantStorage.getStore()
    if (current && current.tenantId !== tenantId) {
      throw new Error(
        `TenantManager.withTenant: nested call with a different tenant — outer "${current.tenantId}" vs inner "${tenantId}". Tenant switches must be explicit (exit the outer scope first).`,
      )
    }
    return tenantStorage.run({ tenantId }, () =>
      this.uow.run(async (tx) => {
        await tx.execute(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
        return fn(tx)
      }),
    )
  }

  /**
   * Run `fn` in a transaction WITHOUT a tenant binding. Intended for
   * admin / migration paths; requires the underlying connection to be
   * a `BYPASSRLS` role to actually see across tenants.
   */
  async withoutTenant<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return tenantStorage.run(null, () => this.uow.run(fn))
  }

  /** Current tenant ID inside any `withTenant` scope, else `null`. */
  currentTenantId(): string | null {
    return tenantStorage.getStore()?.tenantId ?? null
  }
}
