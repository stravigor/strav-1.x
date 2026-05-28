/**
 * `DatabaseProvider` — binds `Database` (singleton) from `config.database`.
 *
 * Lifecycle:
 *   - `register()` binds the `Database` interface (under both the symbol key
 *     `'database'` and the class `PostgresDatabase`).
 *   - `boot()` is a no-op when `lazyConnect: true` (default), so console
 *     commands that don't touch the DB don't open a connection. Apps that
 *     want fail-fast can set `lazyConnect: false` — boot will `connect()`.
 *   - `shutdown()` closes the pool gracefully with `config.database.
 *     shutdownTimeoutSeconds` (default 5).
 *
 * Depends on `'config'` only. Other providers (auth's SessionGuard, future
 * QueueProvider, etc.) declare `dependencies: ['database']` to compose on top.
 */

import { type Application, ConfigError, ConfigRepository, ServiceProvider } from '@strav/kernel'
import {
  AdminDatabase,
  type Database,
  PostgresDatabase,
  type PostgresDatabaseOptions,
} from './database.ts'

export interface DatabaseConfigShape extends PostgresDatabaseOptions {
  /**
   * When false, `boot()` calls `Database.raw().connect()` so config /
   * network errors surface at boot. Default `true` — connect on first use.
   */
  lazyConnect?: boolean
  /** Seconds to wait for in-flight queries before forcing close. Default 5. */
  shutdownTimeoutSeconds?: number
  /**
   * Optional second connection wired for the BYPASSRLS Postgres role.
   * When present, `DatabaseProvider` binds an {@link AdminDatabase}
   * pool that `TenantManager.withoutTenant` / `withLock` route through
   * — so cross-tenant admin queries actually see across tenants without
   * apps having to construct a second `DatabaseProvider` by hand.
   *
   * Omit for single-role setups; the privileged paths fall back to the
   * default pool (which works fine when its role has BYPASSRLS, but
   * that's discouraged in production — the principle is least privilege
   * for the app pool).
   */
  admin?: PostgresDatabaseOptions
}

/** String-key alias under which `Database` is also bound. */
export const DATABASE_KEY = 'database'

/** String-key alias under which `AdminDatabase` is also bound, when configured. */
export const ADMIN_DATABASE_KEY = 'database.admin'

export class DatabaseProvider extends ServiceProvider {
  override readonly name = 'database'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(PostgresDatabase, (c) => {
      const config = c.resolve(ConfigRepository).get('database') as DatabaseConfigShape | undefined
      if (!config?.url) {
        throw new ConfigError(
          'DatabaseProvider: `config.database.url` is missing. Add a `config/database.ts` file with at least a `url` (see docs/database/guides/setup.md).',
        )
      }
      const options: PostgresDatabaseOptions = { url: config.url }
      if (config.idleTimeout !== undefined) options.idleTimeout = config.idleTimeout
      if (config.max !== undefined) options.max = config.max
      return new PostgresDatabase(options)
    })

    // String-key alias so apps can `c.resolve<Database>('database')` without
    // pulling in the concrete class.
    app.singleton(DATABASE_KEY, (c) => c.resolve(PostgresDatabase) as Database)

    // Opt-in BYPASSRLS pool — bound ONLY when `config.database.admin` is set,
    // so `app.has(AdminDatabase)` honestly reflects whether the admin role
    // is wired. Apps that want both pools at once declare the admin slice;
    // apps with a single-role setup omit it and the admin code paths fall
    // back to the default pool (or skip, depending on the caller).
    const dbConfig = app.resolve(ConfigRepository).get('database') as
      | DatabaseConfigShape
      | undefined
    if (dbConfig?.admin?.url) {
      app.singleton(AdminDatabase, () => {
        const adminCfg = dbConfig.admin
        if (!adminCfg?.url) {
          // Defensive — outer check above already gates this branch. Kept
          // so a future refactor that moves the resolution lazy doesn't
          // silently drop the validation.
          throw new ConfigError(
            'AdminDatabase: `config.database.admin.url` disappeared between register() and resolve().',
          )
        }
        const options: PostgresDatabaseOptions = { url: adminCfg.url }
        if (adminCfg.idleTimeout !== undefined) options.idleTimeout = adminCfg.idleTimeout
        if (adminCfg.max !== undefined) options.max = adminCfg.max
        return new AdminDatabase(options)
      })
      app.singleton(ADMIN_DATABASE_KEY, (c) => c.resolve(AdminDatabase) as Database)
    }
  }

  override async boot(app: Application): Promise<void> {
    const config = app.resolve(ConfigRepository).get('database') as DatabaseConfigShape | undefined
    if (config?.lazyConnect === false) {
      // Eagerly establish a connection so config / network errors are loud at
      // boot rather than at first request.
      await app.resolve(PostgresDatabase).raw().connect()
    }
  }

  override async shutdown(app: Application): Promise<void> {
    if (!app.has(PostgresDatabase)) return
    const config = app.resolve(ConfigRepository).get('database') as DatabaseConfigShape | undefined
    const timeout = config?.shutdownTimeoutSeconds ?? 5
    try {
      await app.resolve(PostgresDatabase).close({ timeout })
    } catch {
      // Best-effort shutdown — never throw past the kernel boundary.
    }
    if (app.has(AdminDatabase)) {
      try {
        await app.resolve(AdminDatabase).close({ timeout })
      } catch {
        // Same best-effort policy as the primary pool.
      }
    }
  }
}
