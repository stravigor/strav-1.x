/**
 * `BroadcastProvider` — registers a `MemoryBroadcaster` under the
 * `Broadcaster` token by default.
 *
 * Apps that want the Postgres backplane swap providers:
 *
 *   import { BroadcastProvider } from '@strav/broadcast'
 *   import { PostgresBroadcastProvider } from '@strav/broadcast/postgres'
 *
 *   providers: [
 *     ...,
 *     new PostgresBroadcastProvider(),    // instead of BroadcastProvider
 *   ]
 *
 * Both providers register under the same `Broadcaster` token, so app
 * code injecting `Broadcaster` doesn't change between dev and prod.
 *
 * Eager singleton — the constructor runs at register-time so config
 * errors surface at boot rather than first `publish()`.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Broadcaster } from './broadcaster.ts'
import {
  MemoryBroadcaster,
  type MemoryBroadcasterOptions,
} from './drivers/memory/memory_broadcaster.ts'

export interface MemoryBroadcastConfig extends MemoryBroadcasterOptions {
  driver: 'memory'
}

export class BroadcastProvider extends ServiceProvider {
  override readonly name = 'broadcast'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Broadcaster, (c) => {
      const cfg = c.resolve(ConfigRepository).get('broadcast') as MemoryBroadcastConfig | undefined
      // Default to memory with no overrides if the app didn't configure
      // anything — broadcast is opt-in; explicit config only buys you
      // overrides. Apps that don't use broadcast simply never inject
      // the token.
      return new MemoryBroadcaster(
        cfg !== undefined
          ? {
              ...(cfg.maxBufferSize !== undefined ? { maxBufferSize: cfg.maxBufferSize } : {}),
              ...(cfg.onOverflow !== undefined ? { onOverflow: cfg.onOverflow } : {}),
            }
          : {},
      )
    })
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(Broadcaster)
  }

  override async shutdown(app: Application): Promise<void> {
    await app.resolve(Broadcaster).close()
  }
}
