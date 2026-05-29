/**
 * `StripePaymentProvider` — `ServiceProvider` that registers the
 * Stripe driver factory on the `PaymentManager`.
 *
 * Boot ordering: list AFTER `PaymentProvider` in
 * `bootstrap/providers.ts`. `register()` here calls
 * `manager.extend('stripe', factory)`; then `PaymentProvider.boot`
 * eagerly resolves the manager. Driver instances are constructed
 * on first `payment.use(name)` call (lazy), so misconfigured
 * Stripe secrets surface on first use rather than at boot. Apps
 * that want fail-fast-at-boot semantics call `payment.use('stripe')`
 * from their own `boot()` step.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { PaymentManager } from '../payment_manager.ts'
import { PaymentConfigError } from '../payment_error.ts'
import type { StripeProviderConfig } from './stripe_config.ts'
import { StripePaymentDriver } from './stripe_driver.ts'

export class StripePaymentProvider extends ServiceProvider {
  override readonly name = 'payment-stripe'
  override readonly dependencies = ['payment']

  override register(app: Application): void {
    const manager = app.resolve(PaymentManager)
    manager.extend('stripe', ({ instanceName, config }) => {
      const cfg = config as StripeProviderConfig
      if (!cfg.secret) {
        throw new PaymentConfigError(
          `StripePaymentProvider: \`config.payment.providers["${instanceName}"].secret\` is required.`,
          { context: { instanceName } },
        )
      }
      return new StripePaymentDriver({ instanceName, config: cfg })
    })
  }
}
