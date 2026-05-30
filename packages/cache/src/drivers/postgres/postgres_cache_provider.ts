/**
 * `PostgresCacheProvider` — wires `PostgresCache` under the `Cache`
 * token. Apps register this INSTEAD OF `CacheProvider` to swap the
 * dev-friendly memory cache for the cross-process Postgres backplane.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Cache } from '../../cache.ts'
import {
  PostgresCache,
  type PostgresCacheDatabase,
  type PostgresCacheOptions,
} from './postgres_cache.ts'

export interface PostgresCacheConfig extends Omit<PostgresCacheOptions, 'db'> {
  driver: 'postgres'
}

export class PostgresCacheProvider extends ServiceProvider {
  override readonly name = 'cache'
  override readonly dependencies = ['config', 'database']

  override register(app: Application): void {
    app.singleton(Cache, (c) => {
      // Resolve `Database` by string token to keep the runtime peer-dep
      // on `@strav/database` optional — apps using `MemoryCache`
      // shouldn't pay for `@strav/database` in their bundle.
      const db = c.resolve<PostgresCacheDatabase>('database' as never)
      const cfg = c.resolve(ConfigRepository).get('cache') as PostgresCacheConfig | undefined
      return new PostgresCache({
        db,
        ...(cfg?.cleanupIntervalMs !== undefined
          ? { cleanupIntervalMs: cfg.cleanupIntervalMs }
          : {}),
      })
    })
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(Cache)
  }

  override async shutdown(app: Application): Promise<void> {
    await app.resolve(Cache).close()
  }
}
