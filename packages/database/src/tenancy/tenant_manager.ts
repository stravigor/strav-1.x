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
 * `withTenantLock(id, key, fn)` / `withLock(key, fn)` add a
 * **transaction-level Postgres advisory lock** on top of the existing
 * scope helpers. Use them to serialize concurrent work blocks (one
 * worker at a time per tenant/key, or fleet-wide). Locks auto-release
 * at COMMIT/ROLLBACK — pool-safe.
 *
 * `TenantManager` accepts an optional `adminDb` second pool — when
 * present, `withoutTenant` and `withLock` route through it (the
 * BYPASSRLS Postgres role) so cross-tenant admin queries actually see
 * across tenants. When absent, both fall back to the primary pool —
 * which works when its role has BYPASSRLS, but the recommended setup
 * is least privilege on the app pool + the admin pool for privileged
 * paths. See {@link AdminDatabase} + `docs/database/guides/multi_tenancy.md`.
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
  private readonly appUow: UnitOfWork
  private readonly adminUow: UnitOfWork

  /**
   * @param db Primary (app) pool — used by `withTenant` and `withTenantLock`.
   *   Should be the `NOBYPASSRLS` Postgres role in production so RLS
   *   policies are enforced on every read/write.
   * @param events Optional event bus for Repository lifecycle queue-until-commit.
   * @param adminDb Optional second pool — used by `withoutTenant` and
   *   `withLock`. Should be the `BYPASSRLS` role so cross-tenant queries
   *   see across tenants. Omitting it falls back to using `db` for
   *   privileged paths too — fine for tests / single-role setups.
   */
  constructor(db: Database, events?: EventBus, adminDb?: Database) {
    this.appUow = new UnitOfWork(db, events)
    this.adminUow = adminDb ? new UnitOfWork(adminDb, events) : this.appUow
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
      this.appUow.run(async (tx) => {
        await tx.execute(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
        return fn(tx)
      }),
    )
  }

  /**
   * Run `fn` in a transaction WITHOUT a tenant binding. Intended for
   * admin / migration paths. Routes through the `adminDb` pool when one
   * was supplied to the constructor (the BYPASSRLS role); otherwise
   * falls back to the primary pool.
   */
  async withoutTenant<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return tenantStorage.run(null, () => this.adminUow.run(fn))
  }

  /**
   * Run `fn` inside a tenant-scoped transaction that also holds a
   * **transaction-level advisory lock** keyed by `(tenantId, lockKey)`.
   * The lock auto-releases at COMMIT / ROLLBACK — no `pg_advisory_unlock`
   * to remember, and pool-safe (no stranded session locks if a worker
   * crashes).
   *
   * Use this to serialize concurrent work blocks under the same tenant
   * without a heavyweight row lock:
   *
   * ```ts
   * await tenants.withTenantLock(tenantId, 'invoice-batch', async (tx) => {
   *   const pending = await invoiceRepo.query().where('status', 'pending').all()
   *   for (const invoice of pending) await processInvoice(invoice)
   * })
   * ```
   *
   * The lock partitions cleanly per-tenant (different tenants holding the
   * same `lockKey` don't contend) via Postgres's two-argument
   * `pg_advisory_xact_lock(int, int)`, with `hashtext()` on each. Inside
   * `fn`, Repository calls auto-route through the transaction just like
   * in `withTenant`.
   *
   * If called inside an existing `withTenant(tenantId, ...)`, this acquires
   * the lock on the existing transaction (no nested transaction opened).
   * Nesting with a DIFFERENT tenant throws — same loud-fail rule as
   * `withTenant`.
   */
  async withTenantLock<T>(
    tenantId: string,
    lockKey: string,
    fn: (tx: DatabaseExecutor) => Promise<T>,
  ): Promise<T> {
    if (!lockKey) {
      throw new Error('TenantManager.withTenantLock: lockKey must be a non-empty string.')
    }
    return this.withTenant(tenantId, async (tx) => {
      await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        tenantId,
        lockKey,
      ])
      return fn(tx)
    })
  }

  /**
   * Run `fn` in a transaction that holds a **transaction-level advisory
   * lock** keyed by `lockKey` (no tenant binding). For global / admin
   * serialization — singleton cron jobs, one-time migrations, leadership
   * fences. Uses Postgres's one-argument `pg_advisory_xact_lock(bigint)`
   * with `hashtext()` casting the key to 64-bit.
   *
   * ```ts
   * await tenants.withLock('housekeeping:expire-tokens', async (tx) => {
   *   await tx.execute(...)   // exactly one worker at a time, fleet-wide
   * })
   * ```
   *
   * Like `withoutTenant`, this leaves `app.tenant_id` unset — RLS-
   * protected tables will reject queries unless the connection is a
   * `BYPASSRLS` role.
   */
  async withLock<T>(lockKey: string, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    if (!lockKey) {
      throw new Error('TenantManager.withLock: lockKey must be a non-empty string.')
    }
    return this.withoutTenant(async (tx) => {
      await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [lockKey])
      return fn(tx)
    })
  }

  /** Current tenant ID inside any `withTenant` scope, else `null`. */
  currentTenantId(): string | null {
    return tenantStorage.getStore()?.tenantId ?? null
  }
}
