/**
 * `MailProvider` reads `config('mail')`, constructs a `MailManager`,
 * and binds:
 *   - `MailManager` (singleton) — the public mail surface.
 *   - `'mail'` (string key, singleton) — alias resolving to the same
 *     `MailManager`, so apps can `@inject('mail')` without importing
 *     the class.
 *
 * Depends on `'config'` and `'logger'`, so `ConfigProvider` and
 * `LoggerProvider` must be registered first. The provider's
 * `shutdown()` runs `MailManager.shutdown()` to close every cached
 * transport.
 *
 * @see docs/signal/api.md
 */

import {
  type Application,
  ConfigError,
  ConfigRepository,
  LogManager,
  ServiceProvider,
} from '@strav/kernel'
import { type MailConfig, MailManager } from './mail_manager.ts'

export class MailProvider extends ServiceProvider {
  override readonly name = 'mail'
  override readonly dependencies = ['config', 'logger']

  override register(app: Application): void {
    app.singleton(MailManager, (c) => {
      const raw = c.resolve(ConfigRepository).get('mail')
      if (raw === undefined || raw === null) {
        throw new ConfigError(
          'MailProvider: `config.mail` is missing. Add a `config/mail.ts` file (see docs/signal/README.md).',
        )
      }
      return new MailManager(raw as MailConfig, c.resolve(LogManager), c)
    })
    app.singleton('mail', (c) => c.resolve(MailManager))
  }

  override async boot(app: Application): Promise<void> {
    // Construct the manager now so config errors surface at boot —
    // not on the first send call inside a request.
    app.resolve(MailManager)
  }

  override async shutdown(app: Application): Promise<void> {
    try {
      if (!app.has(MailManager)) return
      await app.resolve(MailManager).shutdown()
    } catch {
      // No manager was constructed (config missing / boot failed earlier) —
      // nothing to clean up.
    }
  }
}
