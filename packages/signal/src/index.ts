// Public API of @strav/signal — mail layer.
//
// Shipping:
//   - The `Message` shape + `MailRecipient` / `MailAddress` /
//     `MessageAttachment`.
//   - The `Transport` driver contract.
//   - Two transports: `ArrayTransport` (in-memory recorder for tests)
//     + `LogTransport` (writes to a `Logger` channel — local-dev).
//   - `MailManager` — multi-transport orchestration with `via(name?)`,
//     default-`from` substitution, lazy/cached transport construction,
//     and a Mailable-aware `send(MailableClass, payload)` overload.
//   - `MailProvider` — wires `MailManager` into the container from
//     `config('mail')`.
//   - `Mailable<TPayload>` — typed `Job` subclass; `build(payload)` is
//     the override point, `handle()` is auto-implemented to send via
//     the default transport. Dispatch via `queue.dispatch(MailableClass,
//     payload)` like any other Job.
//
// Still to land in later signal slices:
//   - Real transports: SMTP, Resend, SendGrid.
//   - Inbound parsers: Postmark, Mailgun.
//   - Notifications (`BaseNotification`, `Notifiable`, channel drivers).
//   - Broadcast pub/sub + SSE kernel handler.

export { type MailConfig, MailManager, type MailTransportConfig } from './mail_manager.ts'
export { MailProvider } from './mail_provider.ts'
export { Mailable, type MailableClass, type MailablePayloadOf } from './mailable.ts'
export type { MailAddress, MailRecipient, Message, MessageAttachment } from './message.ts'
export type { Transport } from './transport.ts'
export { MailTransportError } from './transport_error.ts'
export { ArrayTransport } from './transports/array_transport.ts'
export { LogTransport, type LogTransportOptions } from './transports/log_transport.ts'
export { MailgunTransport, type MailgunTransportOptions } from './transports/mailgun_transport.ts'
export { ResendTransport, type ResendTransportOptions } from './transports/resend_transport.ts'
export {
  SendGridTransport,
  type SendGridTransportOptions,
} from './transports/sendgrid_transport.ts'
