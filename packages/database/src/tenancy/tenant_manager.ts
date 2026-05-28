/**
 * `TenantManager` — runs a callback scoped to one tenant.
 *
 * Inside `withTenant(id, fn)`:
 *   1. Open a transaction.
 *   2. `SELECT set_config('app.tenant_id', $1, true)` — the `true` makes
 *      the binding transaction-local, so it auto-clears on COMMIT /
 *      ROLLBACK.
 *   3. Run `fn(tx)` with the transaction-scoped executor. All RLS-
 *      protected queries inside see only this tenant's rows because
 *      the policies emitted by `emitCreateTable` reference
 *      `current_setting('app.tenant_id')`.
 *
 * `withoutTenant(fn)` opens a transaction without setting the tenant —
 * RLS policies will see an empty `app.tenant_id` and reject queries.
 * For admin / migration paths, apps need to wire a `BYPASSRLS` Postgres
 * role at the connection-config layer; the framework's two-role
 * connection config lands as a follow-up tenancy slice.
 *
 * `AsyncLocalStorage` propagates the current tenant ID through nested
 * async calls so other code (logs, repository hooks, …) can read it
 * via `currentTenantId()`. Nested `withTenant` calls with the SAME
 * tenant pass through; nested calls with a DIFFERENT tenant throw —
 * that's almost always a bug (a function inadvertently called from
 * the wrong tenant context).
 *
 * Deferred to follow-up tenancy slices:
 *   - **Connection-pool role switching.** Today the TenantManager
 *     wraps whatever `Database` it's constructed with; if that's the
 *     app-role pool, queries inside withoutTenant get rejected by RLS.
 *     The followup pairs a bypass-role pool with the manager.
 *   - **Repository integration.** Repository<TModel> queries today don't
 *     route through the transaction-scoped executor inside withTenant.
 *     Apps must use the `tx` parameter passed to `fn` until that
 *     wiring lands.
 *   - **Tenant boot-time validation.** The provider doesn't yet check
 *     that the tenant registry table exists in the live DB with the
 *     expected PK type. Misconfiguration surfaces as a Postgres error
 *     at first query for now.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database, DatabaseExecutor } from '../database.ts'

interface TenantScope {
  tenantId: string
}

/** Module-level ALS — one TenantManager instance share one scope context. */
const storage = new AsyncLocalStorage<TenantScope | null>()

export class TenantManager {
  constructor(private readonly db: Database) {}

  /**
   * Run `fn` inside a tenant-scoped transaction. Sets
   * `app.tenant_id` so RLS policies match.
   *
   * Nested `withTenant(sameId, ...)` passes through (still in scope).
   * Nested `withTenant(differentId, ...)` throws — switching tenant
   * mid-flight is almost always a bug; explicit re-entry would mask it.
   */
  async withTenant<T>(tenantId: string, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    if (!tenantId) {
      throw new Error('TenantManager.withTenant: tenantId must be a non-empty string.')
    }
    const current = storage.getStore()
    if (current && current.tenantId !== tenantId) {
      throw new Error(
        `TenantManager.withTenant: nested call with a different tenant — outer "${current.tenantId}" vs inner "${tenantId}". Tenant switches must be explicit (exit the outer scope first).`,
      )
    }
    return storage.run({ tenantId }, () =>
      this.db.transaction(async (tx) => {
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
    return storage.run(null, () => this.db.transaction(fn))
  }

  /** Current tenant ID inside any `withTenant` scope, else `null`. */
  currentTenantId(): string | null {
    return storage.getStore()?.tenantId ?? null
  }
}
