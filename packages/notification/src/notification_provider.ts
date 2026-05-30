/**
 * `NotificationProvider` — ServiceProvider that wires
 * `NotificationManager` into the container.
 *
 * Eager construction at boot — a malformed config (missing default
 * channel, unknown channel driver) surfaces at startup, not on first
 * `send()` call.
 *
 * Channel adapter packages register themselves AFTER this provider:
 * each `<Channel>NotificationProvider` declares `dependencies =
 * ['notification']` and calls `manager.extend(name, factory)` from
 * its `boot()` so the channel becomes available without the manager
 * needing to import it.
 */

import { type Application, ConfigError, ConfigRepository, ServiceProvider } from '@strav/kernel'
import type { NotificationConfig } from './notification_config.ts'
import { NotificationManager } from './notification_manager.ts'

export class NotificationProvider extends ServiceProvider {
  override readonly name = 'notification'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(NotificationManager, (c) => {
      const config = c.resolve(ConfigRepository).get('notification') as
        | NotificationConfig
        | undefined
      if (!config) {
        throw new ConfigError(
          'NotificationProvider: `config.notification` is missing. Add `config/notification.ts` with at least one channel.',
        )
      }
      return new NotificationManager({ config })
    })
  }

  override async boot(app: Application): Promise<void> {
    // Force-resolve so config errors surface at boot, not on first call.
    app.resolve(NotificationManager)
  }
}
