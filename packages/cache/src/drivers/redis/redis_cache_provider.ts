/**
 * `RedisCacheProvider` — wires `RedisCache` under the `Cache` token.
 * Apps register this INSTEAD OF `CacheProvider` to use Redis as the
 * cross-process backplane.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Cache } from '../../cache.ts'
import { CacheConfigError } from '../../cache_error.ts'
import { RedisCache, type RedisCacheOptions } from './redis_cache.ts'

export interface RedisCacheConfig extends Omit<RedisCacheOptions, 'client'> {
  driver: 'redis'
}

export class RedisCacheProvider extends ServiceProvider {
  override readonly name = 'cache'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Cache, (c) => {
      const cfg = c.resolve(ConfigRepository).get('cache') as RedisCacheConfig | undefined
      if (cfg === undefined || !cfg.url) {
        throw new CacheConfigError(
          'RedisCacheProvider: `config.cache.url` is required (e.g. `redis://127.0.0.1:6379`).',
        )
      }
      return new RedisCache({
        url: cfg.url,
        ...(cfg.prefix !== undefined ? { prefix: cfg.prefix } : {}),
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
