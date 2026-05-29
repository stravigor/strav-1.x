/**
 * `SocialProvider` — `ServiceProvider` that wires
 * `SocialManager` into the container from `config.social`.
 *
 * Adapter packages register their driver factories via their
 * own ServiceProvider (e.g. `LineSocialProvider`) listed AFTER
 * this one in `bootstrap/providers.ts`. The adapter's
 * `register()` calls `manager.extend('line', factory)`; this
 * provider's `boot()` eagerly resolves the manager so config
 * errors surface at boot, not on first call.
 *
 * Driver instances are constructed lazily on first
 * `social.use(name)` call.
 */

import {
  type Application,
  ConfigRepository,
  ServiceProvider,
} from '@strav/kernel'
import { SocialConfigError } from './social_error.ts'
import { SocialManager } from './social_manager.ts'
import type { SocialConfig } from './types.ts'

export class SocialProvider extends ServiceProvider {
  override readonly name = 'social'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(SocialManager, (c) => {
      const raw = c.resolve(ConfigRepository).get('social') as SocialConfig | undefined
      if (!raw) {
        throw new SocialConfigError(
          'SocialProvider: `config.social` is missing. Add `config/social.ts` with at least one provider.',
        )
      }
      if (!raw.providers || Object.keys(raw.providers).length === 0) {
        throw new SocialConfigError(
          'SocialProvider: `config.social.providers` is empty. Configure at least one provider.',
        )
      }
      return new SocialManager({ config: raw })
    })
  }

  override boot(app: Application): void {
    // Force-resolve so config errors surface at boot, not on first call.
    app.resolve(SocialManager)
  }
}
