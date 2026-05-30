/**
 * Map `Stripe.PaymentIntent.NextAction` onto the framework's
 * `PaymentNextAction` union.
 *
 * Stripe's discriminator is `next_action.type`; each variant
 * carries its own field cluster (`promptpay_display_qr_code`,
 * `wechat_pay_display_qr_code`, `redirect_to_url`,
 * `konbini_display_details`, …). We collapse them onto the four
 * framework kinds: `display_qr`, `redirect`, `authorize`,
 * `voucher` (plus `wait` for variants without user-facing
 * detail).
 *
 * Why this lives in `mappers/` (not the driver): the same
 * mapping is useful from app code that pokes the raw intent
 * (`driver.client.paymentIntents.retrieve(id)`) and wants the
 * framework-shaped DTO without re-running `charges.create`.
 */

import type Stripe from 'stripe'
import type { PaymentNextAction } from '../../../dto/index.ts'

function maybeDate(unix: number | null | undefined): Date | undefined {
  if (unix === null || unix === undefined) return undefined
  return new Date(unix * 1000)
}

/**
 * Returns `null` when there's no actionable step (intent is
 * already settled / failed / cancelled, or carries a variant we
 * don't expose). Apps fall back to `intent.next_action` on `raw`
 * for variants we haven't surfaced.
 */
export function stripeNextAction(
  na: Stripe.PaymentIntent.NextAction | null | undefined,
): PaymentNextAction | null {
  if (!na) return null
  switch (na.type) {
    // ─── QR-based ────────────────────────────────────────────────────────
    case 'promptpay_display_qr_code': {
      const d = na.promptpay_display_qr_code
      if (!d) return { kind: 'wait' }
      const action: PaymentNextAction = {
        kind: 'display_qr',
        qrData: d.data ?? '',
      }
      if (d.image_url_png) action.qrImageUrl = d.image_url_png
      return action
    }
    case 'paynow_display_qr_code': {
      const d = na.paynow_display_qr_code
      if (!d) return { kind: 'wait' }
      const action: PaymentNextAction = {
        kind: 'display_qr',
        qrData: d.data ?? '',
      }
      if (d.image_url_png) action.qrImageUrl = d.image_url_png
      return action
    }
    case 'wechat_pay_display_qr_code': {
      const d = na.wechat_pay_display_qr_code
      if (!d) return { kind: 'wait' }
      const action: PaymentNextAction = {
        kind: 'display_qr',
        qrData: d.data ?? '',
      }
      if (d.image_url_png) action.qrImageUrl = d.image_url_png
      return action
    }
    case 'cashapp_handle_redirect_or_display_qr_code':
    case 'swish_handle_redirect_or_display_qr_code': {
      // Hybrid variant — Stripe gives both a redirect URL and a
      // QR; we surface the QR (more universal for desktop checkout).
      const d = (na as unknown as {
        cashapp_handle_redirect_or_display_qr_code?: { qr_code?: { data?: string; image_url_png?: string }; hosted_instructions_url?: string }
        swish_handle_redirect_or_display_qr_code?: { qr_code?: { data?: string; image_url_png?: string }; hosted_instructions_url?: string }
      })[na.type]
      const qr = d?.qr_code
      if (qr?.data) {
        const action: PaymentNextAction = { kind: 'display_qr', qrData: qr.data }
        if (qr.image_url_png) action.qrImageUrl = qr.image_url_png
        return action
      }
      if (d?.hosted_instructions_url) {
        return { kind: 'redirect', url: d.hosted_instructions_url }
      }
      return { kind: 'wait' }
    }
    // ─── Redirect-based ─────────────────────────────────────────────────
    case 'alipay_handle_redirect': {
      const d = na.alipay_handle_redirect
      if (!d?.url) return { kind: 'wait' }
      return { kind: 'redirect', url: d.url }
    }
    case 'wechat_pay_redirect_to_android_app':
    case 'wechat_pay_redirect_to_ios_app': {
      const url = (na as unknown as {
        wechat_pay_redirect_to_android_app?: { data?: string }
        wechat_pay_redirect_to_ios_app?: { native_url?: string }
      })[na.type]
      const target =
        (url as { native_url?: string })?.native_url ??
        (url as { data?: string })?.data
      if (!target) return { kind: 'wait' }
      return { kind: 'redirect', url: target }
    }
    case 'redirect_to_url': {
      const d = na.redirect_to_url
      if (!d?.url) return { kind: 'wait' }
      // 3DS card challenges + most non-card wallet redirects flow
      // through this variant. Stripe doesn't tag which one — we
      // pick `redirect`; apps that need to distinguish read
      // `raw.next_action` (the intent's payment_method type tells
      // the truth).
      return { kind: 'redirect', url: d.url }
    }
    case 'use_stripe_sdk': {
      // Card 3DS challenge — Stripe.js handles the UI, but apps
      // calling server-side need to know an authorize step is
      // pending. Stripe doesn't surface a server-side URL here;
      // apps drive Stripe.js from the publishable key.
      return { kind: 'authorize', url: '' }
    }
    // ─── Voucher / convenience-store ────────────────────────────────────
    case 'konbini_display_details': {
      const d = na.konbini_display_details
      const ref =
        d?.stores?.familymart?.confirmation_number ??
        d?.stores?.lawson?.confirmation_number ??
        d?.stores?.ministop?.confirmation_number ??
        d?.stores?.seicomart?.confirmation_number ??
        ''
      const action: PaymentNextAction = { kind: 'voucher', reference: ref }
      const expires = maybeDate(d?.expires_at)
      if (expires) action.expiresAt = expires
      if (d?.hosted_voucher_url) {
        // Stripe doesn't expose a barcode image directly; the
        // hosted voucher URL is the canonical display.
        action.barcodeImageUrl = d.hosted_voucher_url
      }
      return action
    }
    case 'boleto_display_details':
    case 'oxxo_display_details':
    case 'display_oxxo_details':
    case 'multibanco_display_details': {
      const d = (na as unknown as Record<string, { number?: string; hosted_voucher_url?: string; expires_at?: number }>)[na.type]
      const action: PaymentNextAction = {
        kind: 'voucher',
        reference: d?.number ?? '',
      }
      const expires = maybeDate(d?.expires_at)
      if (expires) action.expiresAt = expires
      if (d?.hosted_voucher_url) action.barcodeImageUrl = d.hosted_voucher_url
      return action
    }
    // ─── No user-facing action ──────────────────────────────────────────
    case 'verify_with_microdeposits':
    case 'card_await_notification':
      return { kind: 'wait' }
    default:
      return { kind: 'wait' }
  }
}
