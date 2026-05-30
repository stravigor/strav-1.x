/**
 * `InstantProvider` — `ServiceProvider` that wires `InstantManager`
 * into the container from `config.instant`.
 *
 * Adapter packages register their drivers separately via their
 * own ServiceProvider (e.g. `LineInstantProvider`). Apps list
 * the adapter providers AFTER `InstantProvider` in
 * `bootstrap/providers.ts` — `register()` runs in declaration
 * order, then `boot()` runs in the same order. Adapter
 * `register()` calls `manager.extend(driver, factory)`; this
 * provider's `boot()` eagerly resolves so config errors surface
 * at startup.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { InstantConfigError } from './errors.ts'
import { InstantManager } from './instant_manager.ts'
import type { InstantConfig } from './types.ts'

export class InstantProvider extends ServiceProvider {
  override readonly name = 'instant'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(InstantManager, (c) => {
      const raw = c.resolve(ConfigRepository).get('instant') as InstantConfig | undefined
      if (!raw) {
        throw new InstantConfigError(
          'InstantProvider: `config.instant` is missing. Add `config/instant.ts` with at least one provider.',
        )
      }
      if (!raw.providers || Object.keys(raw.providers).length === 0) {
        throw new InstantConfigError(
          'InstantProvider: `config.instant.providers` is empty. Configure at least one provider.',
        )
      }
      return new InstantManager({ config: raw })
    })
  }

  override boot(app: Application): void {
    // Force-resolve so config errors surface at boot, not on first send().
    app.resolve(InstantManager)
  }
}
