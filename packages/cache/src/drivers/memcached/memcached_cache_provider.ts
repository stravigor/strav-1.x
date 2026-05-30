import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Cache } from '../../cache.ts'
import { CacheConfigError } from '../../cache_error.ts'
import { MemcachedCache, type MemcachedCacheOptions } from './memcached_cache.ts'

export interface MemcachedCacheConfig extends Omit<MemcachedCacheOptions, 'client'> {
  driver: 'memcached'
}

export class MemcachedCacheProvider extends ServiceProvider {
  override readonly name = 'cache'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Cache, (c) => {
      const cfg = c.resolve(ConfigRepository).get('cache') as MemcachedCacheConfig | undefined
      if (cfg === undefined || !cfg.host || !cfg.port) {
        throw new CacheConfigError(
          'MemcachedCacheProvider: `config.cache.host` and `config.cache.port` are required.',
        )
      }
      return new MemcachedCache({
        host: cfg.host,
        port: cfg.port,
        ...(cfg.prefix !== undefined ? { prefix: cfg.prefix } : {}),
        ...(cfg.connectTimeoutMs !== undefined ? { connectTimeoutMs: cfg.connectTimeoutMs } : {}),
        ...(cfg.requestTimeoutMs !== undefined ? { requestTimeoutMs: cfg.requestTimeoutMs } : {}),
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
