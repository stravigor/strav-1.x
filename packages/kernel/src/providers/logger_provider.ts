/**
 * `LoggerProvider` reads `config('logger')`, constructs a `LogManager`, and
 * binds:
 *   - `LogManager` (singleton) — channel registry and lifecycle owner.
 *   - `Logger` (singleton) — the default-channel logger; what `@inject()` sees.
 *   - `'logger'` (string key, singleton) — alias for the default logger.
 *
 * Depends on `'config'`, so `ConfigProvider` must be registered first. The
 * provider's `shutdown()` flushes and closes every channel destination.
 *
 * @see docs/kernel/guides/logger.md
 */

import { ConfigRepository } from '../config/configuration.ts'
import { type Application, ServiceProvider } from '../core/index.ts'
import { ConfigError } from '../exceptions/config_error.ts'
import { LogManager } from '../logger/log_manager.ts'
import { Logger } from '../logger/logger.ts'
import type { LoggerConfig } from '../logger/types.ts'

export class LoggerProvider extends ServiceProvider {
  override readonly name = 'logger'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(LogManager, (c) => {
      const raw = c.resolve(ConfigRepository).get('logger')
      if (raw === undefined || raw === null) {
        throw new ConfigError(
          'LoggerProvider: `config.logger` is missing. Add a `config/logger.ts` file (see docs/kernel/guides/logger.md).',
        )
      }
      return new LogManager(raw as LoggerConfig)
    })
    app.singleton(Logger, (c) => c.resolve(LogManager).default())
    app.singleton('logger', (c) => c.resolve(Logger))
  }

  override async boot(app: Application): Promise<void> {
    // Construct the manager now so config errors surface at boot — not on
    // the first log call inside a request.
    app.resolve(LogManager)
  }

  override async shutdown(app: Application): Promise<void> {
    try {
      if (!app.has(LogManager)) return
      await app.resolve(LogManager).shutdown()
    } catch {
      // No manager was constructed (config missing / boot failed earlier) —
      // nothing to clean up.
    }
  }
}
