/**
 * `PaymentCharge` — normalized one-shot charge result.
 *
 * Both successful and failed attempts are returned via this DTO
 * (use `status` to distinguish). Vendor exceptions for invalid
 * input — bad currency code, missing customer — are still raised
 * as `PaymentProviderError`.
 *
 * Async payment methods (PromptPay, PayNow, redirect wallets,
 * 3DS bank challenges, convenience-store vouchers) settle in two
 * steps: the framework returns `status: 'requires_action'` plus a
 * `nextAction` discriminator the app uses to drive the UI (show
 * QR, redirect to URL, render voucher). Settlement arrives via
 * the provider's `charge.succeeded` / `charge.failed` webhook.
 */

export type ChargeStatus =
  | 'succeeded'
  | 'pending'
  | 'failed'
  | 'refunded'
  | 'partial_refunded'
  | 'requires_action'

/**
 * What the app must do next to drive an async charge to
 * settlement. Null on synchronous (card) charges.
 *
 * - `display_qr`  show a QR the customer scans with their banking app
 *                 (PromptPay, PayNow, FPS, WeChat Pay in some flows).
 *                 `qrData` is the encoded string; `qrImageUrl` is a
 *                 hosted PNG when the provider gives one.
 * - `redirect`    send the customer to a wallet / bank page
 *                 (TrueMoney, Alipay, GrabPay, KakaoPay, …).
 *                 Returns to `CreateChargeInput.returnUrl`.
 * - `authorize`   3DS bank challenge — same shape as `redirect` but
 *                 semantically distinct (card holder verification,
 *                 not a wallet handoff).
 * - `voucher`     convenience-store voucher / Boleto — show the
 *                 reference number + barcode for the customer to
 *                 pay at a physical counter.
 * - `wait`        the charge is in flight on bank rails; nothing
 *                 to display. Apps poll or wait for the webhook.
 */
export type PaymentNextAction =
  | { kind: 'display_qr'; qrData: string; qrImageUrl?: string; expiresAt?: Date }
  | { kind: 'redirect'; url: string; expiresAt?: Date }
  | { kind: 'authorize'; url: string; expiresAt?: Date }
  | { kind: 'voucher'; reference: string; barcodeImageUrl?: string; expiresAt?: Date }
  | { kind: 'wait' }

/**
 * Structured payment-method spec — drivers materialize the
 * underlying source / token / etc. server-side. Apps that have
 * a pre-tokenized card id can keep passing a string for
 * back-compatibility; the spec is required for QR / wallet /
 * voucher methods because there's no single id to pass.
 *
 * Open-by-extension via the framework's `PaymentMethodSpec`
 * union: when a future driver supports a method not listed here,
 * the union grows and existing drivers throw
 * `ProviderUnsupportedError` until they implement it.
 */
export type PaymentMethodSpec =
  | { kind: 'card'; token: string }
  | { kind: 'promptpay' }
  | { kind: 'paynow' }
  | { kind: 'fps' }
  | { kind: 'truemoney'; phoneNumber: string }
  | { kind: 'alipay' }
  | { kind: 'wechat_pay' }
  | { kind: 'grabpay' }
  | { kind: 'kakaopay' }
  | { kind: 'rabbit_linepay' }
  | { kind: 'konbini'; phoneNumber?: string }

export interface PaymentCharge {
  id: string
  provider: string
  customerId: string | null
  amount: number
  currency: string
  status: ChargeStatus
  paymentMethodId: string | null
  /** Failure code from the provider — `'card_declined'`, etc. Stable across drivers when possible. */
  failureCode: string | null
  failureMessage: string | null
  /**
   * Populated when `status === 'requires_action'` (and sometimes
   * `'pending'`). Null for synchronous charges that settled
   * immediately.
   */
  nextAction: PaymentNextAction | null
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface CreateChargeInput {
  amount: number
  currency: string
  customer?: string
  /**
   * Either a pre-tokenized payment-method id (`'pm_xxx'` /
   * `'tokn_xxx'`) — the v1 shape, kept for back-compat — or a
   * structured spec (`{ kind: 'promptpay' }`, `{ kind: 'card',
   * token: 'tokn_xxx' }`, …). Specs are required for methods
   * that have no single id to reference (QR / wallet / voucher).
   */
  paymentMethod?: string | PaymentMethodSpec
  description?: string
  metadata?: Record<string, string>
  /**
   * Stripe-style: `true` triggers immediate capture; `false`
   * authorises only (apps call `capture` later). Drivers without
   * holds throw `ProviderUnsupportedError` when `false`.
   */
  capture?: boolean
  /**
   * Where the provider returns the customer after a `redirect`
   * or `authorize` next-action. Required for redirect wallets +
   * 3DS challenges; ignored for synchronous card charges.
   * Apps usually set a global default via
   * `config.payment.returnUrl` and override per-call when
   * needed.
   */
  returnUrl?: string
  /**
   * Provider-side idempotency key. Drivers with the `idempotency`
   * capability dedup retried calls with the same key for ~24h
   * (Stripe). Drivers without the capability silently ignore
   * — apps that need guaranteed dedup on those providers build
   * it app-side (claim the key in a DB table before calling).
   */
  idempotencyKey?: string
}

export interface CreateRefundInput {
  charge: string
  /** Amount in minor unit. Omitted = full refund. */
  amount?: number
  reason?: string
  metadata?: Record<string, string>
  /** See `CreateChargeInput.idempotencyKey`. */
  idempotencyKey?: string
}

export interface PaymentRefund {
  id: string
  provider: string
  chargeId: string
  amount: number
  currency: string
  status: 'pending' | 'succeeded' | 'failed'
  reason: string | null
  createdAt: Date
  raw: unknown
}
