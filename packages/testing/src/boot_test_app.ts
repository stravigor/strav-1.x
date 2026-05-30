/**
 * Boot a tested Application with the standard four providers
 * (`ConfigProvider` → `LoggerProvider` → `DatabaseProvider` →
 * `TenantManagerProvider`) pre-installed, real Postgres reset, schemas
 * applied, optional migrations run, and the per-test providers wired
 * on top. Returns the started `app`, the admin-level `setupDb` (kept
 * open until `dispose()`), and the `dispose()` cleanup that pairs with
 * `afterAll`.
 *
 * Replaces the ~50 LOC `beforeAll` boilerplate that every integration
 * / e2e suite was rolling by hand. Per-test variation (custom config
 * sub-trees, schemas, migrations, post-boot `useDriver` hand-wiring,
 * HTTP server spin-up) lives where it always did.
 *
 * ```ts
 * import { afterAll, beforeAll, describe } from 'bun:test'
 * import {
 *   bootTestApp,
 *   isPostgresAvailable,
 *   type BootTestAppResult,
 * } from '@strav/testing'
 * import { RagProvider, ragVectorSchema, applyRagVectorMigration } from '@strav/rag'
 *
 * const PG = await isPostgresAvailable()
 *
 * describe.skipIf(!PG)('M5 e2e', () => {
 *   let booted: BootTestAppResult
 *   beforeAll(async () => {
 *     booted = await bootTestApp({
 *       config: { rag: { ... } },
 *       schemas: [tenantSchema, articleSchema, ragVectorSchema],
 *       migrations: [(db, registry) => applyRagVectorMigration(db, { dimension: 4, registry })],
 *       providers: [new StubBrainProvider(), new RagProvider()],
 *     })
 *   })
 *   afterAll(() => booted.dispose())
 *
 *   // test cases pull from `booted.app.resolve(...)` and `booted.setupDb`.
 * })
 * ```
 *
 * The orchestration order, per spec from the e2e survey:
 *
 *   1. `createTestDatabase()` → admin connection for setup.
 *   2. `resetSchema(setupDb)` → DROP + CREATE `public`.
 *   3. Apply each schema's `emitCreateTable(schema, { registry }).sql`.
 *   4. Run each migration with `(setupDb, registry)`.
 *   5. Construct config via `composeTestConfig(config)` (auto-supplies
 *      logger + database.url unless overridden).
 *   6. `new Application()`, `useProviders([Config, Logger, Database,
 *      TenantManager, ...userProviders])` unless `skipDefaultProviders`.
 *   7. Bind `SchemaRegistry` as a singleton with `schemas` registered.
 *   8. `await app.start({ signalHandlers: false })`.
 */

import {
  DatabaseProvider,
  PostgresDatabase,
  type Schema,
  SchemaRegistry,
  emitCreateTable,
} from '@strav/database'
import {
  Application,
  ConfigProvider,
  LoggerProvider,
  type ServiceProvider,
} from '@strav/kernel'
import { type ConfigOverrides, composeTestConfig } from './compose_test_config.ts'
import { createTestDatabase } from './postgres/create_test_database.ts'
import { resetSchema } from './postgres/reset_schema.ts'
import { TenantManagerProvider } from './tenant_manager_provider.ts'

/** Migration hook signature — runs against `setupDb` before `app.start`. */
export type TestMigration = (
  db: PostgresDatabase,
  registry: SchemaRegistry,
) => Promise<void> | void

export interface BootTestAppOptions {
  /**
   * Per-test config sub-trees. `logger` and `database` keys are
   * auto-supplied unless overridden here. Other keys (`rag`, `payment`,
   * `social`, `encryption`, …) are passed through verbatim.
   */
  config?: ConfigOverrides
  /**
   * Schemas registered in the `SchemaRegistry` singleton AND applied
   * via `emitCreateTable(schema, { registry }).sql` against `setupDb`
   * before `app.start`. Order matters when there are FK dependencies.
   */
  schemas?: readonly Schema[]
  /**
   * Migrations to run after `schemas` are applied. Each receives the
   * admin connection + the registry so it can compose SQL the same way
   * the production migration helpers do.
   */
  migrations?: readonly TestMigration[]
  /**
   * Per-test service providers — appended after the standard four
   * (`Config`, `Logger`, `Database`, `TenantManager`). Order within
   * this list matters for the kernel's topological sort.
   */
  providers?: readonly ServiceProvider[]
  /**
   * Opt out of the standard four. Useful for tests that need a custom
   * `LoggerProvider`, no `DatabaseProvider`, etc. When `true`, you own
   * the entire provider list via `providers`. Default `false`.
   */
  skipDefaultProviders?: boolean
}

export interface BootTestAppResult {
  /** Started Application — call `resolve(X)` from test cases. */
  app: Application
  /**
   * Admin-level Postgres connection used to apply DDL + migrations and
   * to run setup queries (seeding tenants, asserting schema state). Kept
   * open until `dispose()`.
   */
  setupDb: PostgresDatabase
  /** Cleanup: shutdown app + close setupDb. Use in `afterAll`. */
  dispose(): Promise<void>
}

export async function bootTestApp(options: BootTestAppOptions = {}): Promise<BootTestAppResult> {
  const setupDb = createTestDatabase()
  await resetSchema(setupDb)

  const schemas = options.schemas ?? []
  const registry = new SchemaRegistry().registerAll(schemas)

  for (const schema of schemas) {
    await setupDb.execute(emitCreateTable(schema, { registry }).sql)
  }

  for (const migration of options.migrations ?? []) {
    await migration(setupDb, registry)
  }

  const configData = composeTestConfig(options.config ?? {})

  const app = new Application()
  const defaults = options.skipDefaultProviders
    ? []
    : [
        new ConfigProvider(configData),
        new LoggerProvider(),
        new DatabaseProvider(),
        new TenantManagerProvider(),
      ]
  app.useProviders([...defaults, ...(options.providers ?? [])])

  // Bind the SchemaRegistry singleton so repositories that need it can
  // resolve through the container instead of getting hand-wired.
  app.singleton(SchemaRegistry, () => registry)

  await app.start({ signalHandlers: false })

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await app.shutdown()
    await setupDb.close({ timeout: 2 })
  }

  return { app, setupDb, dispose }
}
