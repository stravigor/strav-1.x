import { DatabaseProvider, PostgresDatabase, SchemaRegistry, TenantManager } from '@strav/database'
import { HttpProvider, MiddlewareRegistry, Router } from '@strav/http'
import {
  type Application,
  ConfigProvider,
  EventBus,
  LoggerProvider,
  ServiceProvider,
} from '@strav/kernel'
import { TenantMiddleware } from '../app/Http/Middleware/tenant_middleware.ts'
import { registerRoutes } from '../app/Http/routes.ts'
import appConfig from '../config/app.ts'
import databaseConfig from '../config/database.ts'
import httpConfig from '../config/http.ts'
import loggerConfig from '../config/logger.ts'
import { postSchema } from '../database/schemas/post_schema.ts'
import { tenantSchema } from '../database/schemas/tenant_schema.ts'

/**
 * Provider that wires the e2e fixture surface on top of the kernel/http/
 * database stack: registers schemas, binds `TenantManager`, registers
 * the `tenant` middleware, and declares the routes.
 */
class AppProvider extends ServiceProvider {
  override readonly name = 'app'
  override readonly dependencies = ['database', 'http']

  override register(app: Application): void {
    // SchemaRegistry — manual registration here (auto-discovery is also
    // available via `.discover('database/schemas/**/*.ts')`; we register
    // explicitly so the test setup can pre-build the tables before the
    // app starts handling requests).
    app.singleton(SchemaRegistry, () =>
      new SchemaRegistry().registerAll([tenantSchema, postSchema]),
    )

    // TenantManager — built on the bound Database + EventBus. TenantManager
    // accepts a Database interface, but the container binds the concrete
    // PostgresDatabase, so we resolve that.
    app.singleton(
      TenantManager,
      (c) => new TenantManager(c.resolve(PostgresDatabase), c.resolve(EventBus)),
    )
  }

  override async boot(app: Application): Promise<void> {
    // Register the `tenant` middleware by name so routes can reference it.
    app.resolve(MiddlewareRegistry).register('tenant', TenantMiddleware)

    // Declare routes against the router.
    registerRoutes(app.resolve(Router))
  }
}

export function providers(): ServiceProvider[] {
  return [
    new ConfigProvider({
      app: appConfig,
      database: databaseConfig,
      http: httpConfig,
      logger: loggerConfig,
    }),
    new LoggerProvider(),
    new DatabaseProvider(),
    new HttpProvider(),
    new AppProvider(),
  ]
}
