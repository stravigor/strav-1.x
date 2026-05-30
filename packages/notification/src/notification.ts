/**
 * `BaseNotification` — apps subclass this to define a notification.
 *
 * Two responsibilities the subclass owns:
 *
 *   1. `via(notifiable)` — return the channel names the manager
 *      fan-outs to. Apps that pre-load a user's channel preferences
 *      branch here (e.g. `notifiable.preferences.email === true`).
 *
 *   2. One `to<Channel>(notifiable)` hook per channel the notification
 *      supports. The hook returns the channel's input shape (a `Message`
 *      for mail, a `NotificationPayload` for database, etc.). Channels
 *      whose hook isn't implemented get skipped — no runtime error.
 *
 * Hooks aren't declared on the base class because each channel knows
 * its own input type and reaches for the named method at dispatch time.
 * Apps that want compile-time hook enforcement extend a per-channel
 * mixin (out of scope for v1 — bring your own discipline for now).
 */

import type { Notifiable } from './notifiable.ts'

export abstract class BaseNotification {
  /** Channel names the manager fan-outs to. Apps override. */
  abstract via(notifiable: Notifiable): readonly string[]
}
