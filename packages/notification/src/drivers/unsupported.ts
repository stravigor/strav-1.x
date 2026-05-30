/**
 * Shared "throw unsupported" helper. Mirrors the same pattern in
 * `@strav/payment/drivers/unsupported.ts` and
 * `@strav/social/drivers/unsupported.ts` — kept inline for
 * package-specific error code throwing.
 */

import { NotificationDeliveryError } from '../notification_error.ts'

export function unsupported(channel: string, reason?: string): never {
  throw new NotificationDeliveryError(
    `Channel "${channel}" cannot perform this operation${reason ? `: ${reason}` : ''}.`,
    { context: { channel } },
  )
}
