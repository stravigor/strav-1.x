/**
 * `PaymentProvider` — `ServiceProvider` that wires
 * `PaymentManager`, `PaymentWebhookEventRepository`, and
 * (when ledger is enabled) `PaymentLedger` into the container
 * from `config.payment`.
 *
 * Adapter packages register their drivers separately via their
 * own ServiceProvider (e.g. `StripePaymentProvider`) in
 * `register()` BEFORE this provider's `boot()` runs. The order
 * is enforced by listing the adapter providers AFTER
 * `PaymentProvider` in the app's `bootstrap/providers.ts` —
 * `register()` runs in declaration order, then `boot()` runs in
 * the same order. Adapter `register()` calls
 * `manager.extend(driver, factory)`; this provider's `boot()`
 * eagerly resolves each configured instance, surfacing config
 * errors at boot.
 *
 * Alternatively, an adapter's `boot()` can do the eager resolve
 * itself. Either pattern is supported.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase + TenantManager value imports for the container's binding factory.
import { PostgresDatabase, TenantManager } from '@strav/database'
import {
  type Application,
  ConfigRepository,
  ServiceProvider,
} from '@strav/kernel'
import { PaymentLedger } from './ledger/payment_ledger.ts'
import { PaymentConfigError } from './payment_error.ts'
import { PaymentManager } from './payment_manager.ts'
import type { PaymentConfig } from './types.ts'
import { PaymentWebhookEventRepository } from './webhook/payment_webhook_event_repository.ts'
// biome-ignore lint/style/useImportType: EventBus value import for the container's binding factory.
import { EventBus } from '@strav/kernel'

export class PaymentProvider extends ServiceProvider {
  override readonly name = 'payment'
  override readonly dependencies = ['config', 'database']

  override register(app: Application): void {
    app.singleton(PaymentManager, (c) => {
      const raw = c.resolve(ConfigRepository).get('payment') as PaymentConfig | undefined
      if (!raw) {
        throw new PaymentConfigError(
          'PaymentProvider: `config.payment` is missing. Add `config/payment.ts` with at least one provider.',
        )
      }
      if (!raw.providers || Object.keys(raw.providers).length === 0) {
        throw new PaymentConfigError(
          'PaymentProvider: `config.payment.providers` is empty. Configure at least one provider.',
        )
      }

      const ledgerEnabled = raw.ledger?.enabled ?? true
      const ledger = ledgerEnabled ? new PaymentLedger(c.resolve(PostgresDatabase)) : undefined

      // TenantManager is optional — apps that don't use the
      // multi-tenant database surface can still use payment.
      // When present, the webhook dispatcher uses it to scope
      // ledger writes + user handlers per-event.
      let tenantManager: TenantManager | undefined
      try {
        tenantManager = c.resolve(TenantManager)
      } catch {
        tenantManager = undefined
      }

      return new PaymentManager({
        config: raw,
        ...(ledger ? { ledger } : {}),
        ...(tenantManager ? { tenantManager } : {}),
      })
    })

    app.singleton(
      PaymentWebhookEventRepository,
      (c) =>
        new PaymentWebhookEventRepository({
          db: c.resolve(PostgresDatabase),
          events: c.resolve(EventBus),
        }),
    )
  }

  override boot(app: Application): void {
    // Force-resolve so config errors surface at boot. Driver
    // instances are constructed lazily on first `use()` — adapter
    // ServiceProviders register the factories during `register()`,
    // which by this point has already run.
    app.resolve(PaymentManager)
  }
}
