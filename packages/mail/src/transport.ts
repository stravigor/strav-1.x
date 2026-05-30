/**
 * `Transport` — the per-driver contract every mail backend implements.
 *
 * `MailManager` holds a name → `Transport` map (Resend, SMTP, log,
 * array, …) and delegates `send()` to the one named in `config.mail.default`
 * (or whichever the caller passed to `via()`). Drivers translate the
 * `Message` shape into their provider format and report transport
 * errors by throwing.
 *
 * Lifecycle
 *   `close()` is optional. Implementations that hold long-lived
 *   resources (a pooled SMTP connection, a kept-alive HTTPS agent) use
 *   it to flush and release; the `MailManager.shutdown()` path awaits
 *   every cached transport's `close()` best-effort.
 *
 * Authoring a new driver
 *   1. Class implementing `Transport`.
 *   2. Constructor takes its config shape — never the global `MailConfig`.
 *   3. `send()` rejects with an `Error` subclass that carries enough
 *      context for the queue Worker's `failed()` hook to log usefully
 *      (provider, status, attempted recipients).
 *   4. Register the driver in `MailManager.buildTransport` (alpha-N
 *      bumps; once 1.0 ships, a `MailTransportRegistry` lets apps
 *      register additional drivers without forking).
 */

import type { Message } from './message.ts'

export interface Transport {
  /** Transmit `message`. Throws on transport-level failure. */
  send(message: Message): Promise<void>
  /** Optional cleanup. Called once on manager shutdown. Must not throw. */
  close?(): void | Promise<void>
}
