/**
 * Beacon event type-guard helpers.
 *
 * Beacons are LINE-only. The normalized `WebhookEvent` already
 * carries beacon payloads in the `BeaconEvent` variant; this
 * module just exposes a tiny helper so apps don't repeat the
 * discriminator check.
 */

import type { BeaconEvent, WebhookEvent } from '../webhook_event.ts'

export function isBeaconEvent(event: WebhookEvent): event is BeaconEvent {
  return event.type === 'beacon'
}
