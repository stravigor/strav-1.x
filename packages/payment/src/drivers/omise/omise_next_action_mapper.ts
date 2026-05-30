/**
 * Map an Omise source + charge pair onto `PaymentNextAction`.
 *
 * Omise splits the async-payment surface across two objects:
 *
 *   - **QR-based** (PromptPay, FPS, DuitNow QR, …):
 *     `source.scannable_code.image.download_uri` is the PNG.
 *     The charge has no `authorize_uri`. Apps display the
 *     image; the customer pays via banking app; the webhook
 *     fires when settlement lands.
 *
 *   - **Redirect-based** (TrueMoney, Alipay, GrabPay, Rabbit
 *     LINE Pay, WeChat Pay): `charge.authorize_uri` is the
 *     URL the app sends the customer to. Omise routes back to
 *     `return_uri` (passed when creating the charge).
 *
 * Omise doesn't expose the raw EMV / SGQR string the way Stripe
 * does — only the rendered PNG. We mirror it into both
 * `qrData` and `qrImageUrl` so apps using either field work; the
 * raw image url is what they actually display.
 */

import type { PaymentNextAction } from '../../dto/index.ts'

interface OmiseSourceLike {
  flow?: string
  scannable_code?: {
    image?: { download_uri?: string }
  }
  references?: { expires_at?: string }
}

interface OmiseChargeLike {
  authorize_uri?: string | null
  expires_at?: string
  source?: OmiseSourceLike | null
}

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function omiseNextAction(
  charge: OmiseChargeLike,
  source?: OmiseSourceLike,
): PaymentNextAction | null {
  const src = source ?? charge.source ?? undefined
  const flow = src?.flow

  // Redirect-based — charge.authorize_uri is the URL to send the
  // customer to. Some flows (wechat_pay) carry both a QR and a
  // redirect; if both are present we prefer the QR (universal for
  // desktop checkout).
  const qrImage = src?.scannable_code?.image?.download_uri
  if (qrImage) {
    const action: PaymentNextAction = {
      kind: 'display_qr',
      // Omise gives the rendered PNG URL, not the raw EMV string.
      // Mirroring it into both slots lets either app handler work.
      qrData: qrImage,
      qrImageUrl: qrImage,
    }
    const expires = parseDate(src?.references?.expires_at ?? charge.expires_at)
    if (expires) action.expiresAt = expires
    return action
  }

  if (charge.authorize_uri) {
    const action: PaymentNextAction = {
      kind: 'redirect',
      url: charge.authorize_uri,
    }
    const expires = parseDate(charge.expires_at)
    if (expires) action.expiresAt = expires
    return action
  }

  // Source flow declared but neither field surfaced — Omise hasn't
  // populated the charge yet; the app waits for the webhook.
  if (flow === 'offline' || flow === 'redirect') {
    return { kind: 'wait' }
  }

  return null
}

export type { OmiseChargeLike, OmiseSourceLike }
