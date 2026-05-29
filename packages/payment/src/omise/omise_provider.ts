/**
 * `OmisePaymentProvider` — `ServiceProvider` that registers the
 * Omise driver factory on the `PaymentManager`.
 *
 * Apps list this AFTER `PaymentProvider` in
 * `bootstrap/providers.ts`. Driver instances construct lazily on
 * first `payment.use(name)` call.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { PaymentManager } from '../payment_manager.ts'
import { PaymentConfigError } from '../payment_error.ts'
import type { OmiseProviderConfig } from './omise_config.ts'
import { OmisePaymentDriver } from './omise_driver.ts'

export class OmisePaymentProvider extends ServiceProvider {
  override readonly name = 'payment-omise'
  override readonly dependencies = ['payment']

  override register(app: Application): void {
    const manager = app.resolve(PaymentManager)
    manager.extend('omise', ({ instanceName, config }) => {
      const cfg = config as OmiseProviderConfig
      if (!cfg.publicKey || !cfg.secretKey) {
        throw new PaymentConfigError(
          `OmisePaymentProvider: \`publicKey\` and \`secretKey\` are required for provider "${instanceName}".`,
          { context: { instanceName } },
        )
      }
      return new OmisePaymentDriver({ instanceName, config: cfg })
    })
  }
}
