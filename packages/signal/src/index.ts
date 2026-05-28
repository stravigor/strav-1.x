// Public API of @strav/signal — slice 1: mail core.
//
// V1 ships:
//   - The `Message` shape + `MailRecipient` / `MailAddress` /
//     `MessageAttachment`.
//   - The `Transport` driver contract.
//   - Two transports: `ArrayTransport` (in-memory recorder for tests)
//     + `LogTransport` (writes to a `Logger` channel — local-dev).
//   - `MailManager` — multi-transport orchestration with `via(name?)`,
//     default-`from` substitution, and lazy/cached transport construction.
//   - `MailProvider` — wires `MailManager` into the container from
//     `config('mail')`.
//
// Still to land in later signal slices:
//   - `Mailable` base class + queue-dispatch integration (so apps can
//     `mail.queue(new WelcomeEmail(user))` and have a Worker handle the
//     send).
//   - Real transports: SMTP, Resend, SendGrid.
//   - Inbound parsers: Postmark, Mailgun.
//   - Notifications (`BaseNotification`, `Notifiable`, channel drivers).
//   - Broadcast pub/sub + SSE kernel handler.

export { type MailConfig, MailManager, type MailTransportConfig } from './mail_manager.ts'
export { MailProvider } from './mail_provider.ts'
export type { MailAddress, MailRecipient, Message, MessageAttachment } from './message.ts'
export type { Transport } from './transport.ts'
export { ArrayTransport } from './transports/array_transport.ts'
export { LogTransport, type LogTransportOptions } from './transports/log_transport.ts'
