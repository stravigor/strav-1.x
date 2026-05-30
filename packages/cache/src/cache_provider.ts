/**
 * `CacheProvider` — registers `MemoryCache` under the `Cache` token by
 * default.
 *
 * Apps that want the Postgres backplane swap providers:
 *
 *   import { CacheProvider } from '@strav/cache'
 *   import { PostgresCacheProvider } from '@strav/cache/postgres'
 *
 *   providers: [
 *     ...,
 *     new PostgresCacheProvider(),    // INSTEAD OF CacheProvider
 *   ]
 *
 * Both providers register under the same `Cache` token, so app code
 * injecting `Cache` doesn't change between dev and prod.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Cache } from './cache.ts'
import { MemoryCache, type MemoryCacheOptions } from './drivers/memory/memory_cache.ts'

export interface MemoryCacheConfig extends MemoryCacheOptions {
  driver: 'memory'
}

export class CacheProvider extends ServiceProvider {
  override readonly name = 'cache'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Cache, (c) => {
      const cfg = c.resolve(ConfigRepository).get('cache') as MemoryCacheConfig | undefined
      return new MemoryCache(cfg !== undefined && cfg.now !== undefined ? { now: cfg.now } : {})
    })
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(Cache)
  }

  override async shutdown(app: Application): Promise<void> {
    await app.resolve(Cache).close()
  }
}
