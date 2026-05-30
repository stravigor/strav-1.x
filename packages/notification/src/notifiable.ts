/**
 * `Notifiable` — the minimum a notification recipient must expose.
 *
 * Apps' domain models implement this interface (or extend it via mixin
 * / Repository pattern). Channel-specific data lives on the domain
 * shape: a `User` notifiable might have `email: string` for the mail
 * channel, `phone: string` for an SMS channel, and any per-channel
 * routing-preference fields the app cares about.
 *
 * The framework stays out of the routing decision — each notification's
 * `via(notifiable)` returns the channels to dispatch through, and each
 * channel reads what it needs off the notifiable directly.
 */

export interface Notifiable {
  /** Identity. Channels persist this on delivery rows so apps can resolve back. */
  readonly id: string | number
  /** Class / type name. Channels record this alongside the id for polymorphic resolution. */
  readonly notifiableType?: string
  /** Apps add channel-specific fields directly: `email`, `phone`, `preferences`, …. */
  [key: string]: unknown
}
