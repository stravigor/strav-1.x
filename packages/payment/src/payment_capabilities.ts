/**
 * `PaymentCapability` — granular feature flags every driver
 * declares in `driver.capabilities`. Apps that build provider-
 * neutral flows check capability before calling:
 *
 *   if (payment.use('omise').capabilities.has('checkout')) { ... }
 *
 * Drivers omit a capability when they can't fulfil it
 * faithfully — partial / surprising implementations are worse
 * than `ProviderUnsupportedError`. Apps reach `.raw` when they
 * need provider-specific behaviour that doesn't map to a
 * capability.
 *
 * Capability granularity is intentionally fine-grained (one per
 * non-trivial *Ops method, not one per *Ops group) so e.g.
 * Paddle can support `subscriptions.create` but not
 * `subscriptions.changePlan` without losing the rest.
 */

export type PaymentCapability =
  // customers
  | 'customers.create'
  | 'customers.update'
  | 'customers.retrieve'
  | 'customers.list'
  | 'customers.delete'
  // products + prices
  | 'products.create'
  | 'products.update'
  | 'products.list'
  | 'prices.create'
  | 'prices.list'
  // subscriptions
  | 'subscriptions.create'
  | 'subscriptions.retrieve'
  | 'subscriptions.update'
  | 'subscriptions.cancel'
  | 'subscriptions.changePlan'
  | 'subscriptions.trials'
  // payment methods
  | 'paymentMethods.attach'
  | 'paymentMethods.detach'
  | 'paymentMethods.list'
  // charges
  | 'charges.create'
  | 'charges.refund'
  | 'charges.capture'
  // charges — payment-method specs the driver accepts as input.
  // Fine-grained so apps can build method pickers that only show
  // what the routed driver can take.
  | 'charges.method.card'
  | 'charges.method.promptpay'
  | 'charges.method.paynow'
  | 'charges.method.fps'
  | 'charges.method.truemoney'
  | 'charges.method.alipay'
  | 'charges.method.wechat_pay'
  | 'charges.method.grabpay'
  | 'charges.method.kakaopay'
  | 'charges.method.rabbit_linepay'
  | 'charges.method.konbini'
  // charges — next-action kinds the driver can emit. Apps that
  // host their own QR / redirect UI check these to know what
  // shapes they need to handle.
  | 'charges.nextAction.display_qr'
  | 'charges.nextAction.redirect'
  | 'charges.nextAction.authorize'
  | 'charges.nextAction.voucher'
  | 'charges.nextAction.wait'
  // invoices
  | 'invoices.list'
  | 'invoices.retrieve'
  | 'invoices.finalize'
  | 'invoices.void'
  // checkout (hosted)
  | 'checkout.create'
  | 'checkout.retrieve'
  // payment links — shareable hosted pay URLs.
  | 'links.create'
  | 'links.deactivate'
  // Driver enforces server-side idempotency when `idempotencyKey`
  // is set on supported create-style inputs. When NOT declared,
  // the driver silently ignores the field — apps that need
  // guaranteed dedup build it app-side (claim the key in a DB
  // table before calling). Single flag covers every supported
  // method (charges, refunds, subscriptions, links, checkout,
  // customers).
  | 'idempotency'
  // webhooks
  | 'webhook.verify'
  | 'webhook.normalize'
