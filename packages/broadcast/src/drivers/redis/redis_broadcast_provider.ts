/**
 * `RedisBroadcastProvider` — wires `RedisBroadcaster` under the
 * `Broadcaster` token. Apps register this INSTEAD OF `BroadcastProvider`
 * (or `PostgresBroadcastProvider`) to use Redis Pub/Sub as the
 * multi-node backplane.
 *
 * Reads `config.broadcast` for the connection URL + buffer knobs.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { BroadcastConfigError } from '../../broadcast_error.ts'
import { Broadcaster } from '../../broadcaster.ts'
import { RedisBroadcaster, type RedisBroadcasterOptions } from './redis_broadcaster.ts'

export interface RedisBroadcastConfig extends Omit<RedisBroadcasterOptions, 'pub' | 'sub'> {
  driver: 'redis'
}

export class RedisBroadcastProvider extends ServiceProvider {
  override readonly name = 'broadcast'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Broadcaster, (c) => {
      const cfg = c.resolve(ConfigRepository).get('broadcast') as RedisBroadcastConfig | undefined
      if (cfg === undefined || cfg.url === undefined || cfg.url === '') {
        throw new BroadcastConfigError(
          'RedisBroadcastProvider: `config.broadcast.url` is required (e.g. `redis://127.0.0.1:6379`).',
        )
      }
      return new RedisBroadcaster({
        url: cfg.url,
        ...(cfg.maxBufferSize !== undefined ? { maxBufferSize: cfg.maxBufferSize } : {}),
        ...(cfg.onOverflow !== undefined ? { onOverflow: cfg.onOverflow } : {}),
      })
    })
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(Broadcaster)
  }

  override async shutdown(app: Application): Promise<void> {
    await app.resolve(Broadcaster).close()
  }
}
