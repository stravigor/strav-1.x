import { DatabaseProvider, PostgresDatabase, SchemaRegistry, TenantManager } from '@strav/database'
import { HttpProvider, MiddlewareRegistry, Router } from '@strav/http'
import {
  type Application,
  ConfigProvider,
  EventBus,
  LoggerProvider,
  ServiceProvider,
} from '@strav/kernel'
import { PostRepository } from '../app/Repositories/post_repository.ts'
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

    // Repositories — bind explicitly. Repository's options-bag
    // constructor (`{ db, events?, registry?, cipher? }`) doesn't
    // round-trip through @inject() auto-construction (the param is
    // an interface, not a runtime class). PostsController declares
    // `posts: PostRepository` and the container resolves it via this
    // binding.
    app.singleton(
      PostRepository,
      (c) =>
        new PostRepository({
          db: c.resolve(PostgresDatabase),
          events: c.resolve(EventBus),
        }),
    )

    // Middleware + routes register here (not in boot()) because
    // HttpProvider.boot() compiles the router — adding groups after compile
    // throws `Router: cannot add a group after compile().`. register() runs
    // strictly before any boot(), so the registry and router are both bound
    // and mutable at this point. The dependency declaration above still
    // ensures HttpProvider.register() ran first.
    app.resolve(MiddlewareRegistry).register('tenant', TenantMiddleware)
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
