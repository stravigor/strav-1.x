/**
 * `PostgresBroadcastProvider` — wires `PostgresBroadcaster` under the
 * `Broadcaster` token. Apps register this INSTEAD OF
 * `BroadcastProvider` to swap the dev-friendly memory backplane for
 * the multi-node Postgres ledger.
 *
 * Reads `config.broadcast` for the polling / retention knobs; the
 * `Database` binding is resolved straight from the container.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Broadcaster } from '../../broadcaster.ts'
import {
  PostgresBroadcaster,
  type PostgresBroadcasterDatabase,
  type PostgresBroadcasterOptions,
} from './postgres_broadcaster.ts'

export interface PostgresBroadcastConfig extends Omit<PostgresBroadcasterOptions, 'db'> {
  driver: 'postgres'
}

export class PostgresBroadcastProvider extends ServiceProvider {
  override readonly name = 'broadcast'
  override readonly dependencies = ['config', 'database']

  override register(app: Application): void {
    app.singleton(Broadcaster, (c) => {
      // Resolve `Database` by string token to avoid a hard import dep
      // on `@strav/database` from this package's barrel — the peer is
      // optional and only loaded when this provider is registered.
      const db = c.resolve<PostgresBroadcasterDatabase>('database' as never)
      const cfg = c.resolve(ConfigRepository).get('broadcast') as
        | PostgresBroadcastConfig
        | undefined
      return new PostgresBroadcaster({
        db,
        ...(cfg?.pollIntervalMs !== undefined ? { pollIntervalMs: cfg.pollIntervalMs } : {}),
        ...(cfg?.retentionSeconds !== undefined ? { retentionSeconds: cfg.retentionSeconds } : {}),
        ...(cfg?.cleanupIntervalMs !== undefined
          ? { cleanupIntervalMs: cfg.cleanupIntervalMs }
          : {}),
        ...(cfg?.maxBufferSize !== undefined ? { maxBufferSize: cfg.maxBufferSize } : {}),
        ...(cfg?.onOverflow !== undefined ? { onOverflow: cfg.onOverflow } : {}),
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
