# @strav/signal

Outbound communication for Strav 1.0. Slice 1 ships the **mail core**:

- `Message` + `MailRecipient` + `MailAddress` + `MessageAttachment` — the plain-data envelope.
- `Transport` interface — what every backend implements (`send`, optional `close`).
- `ArrayTransport` — in-memory recorder for tests.
- `LogTransport` — writes `mail.sent` records to a `Logger` channel; local-dev default.
- `MailManager` — multi-transport orchestration with default-`from` substitution + lazy/cached transport build.
- `MailProvider` — wires `config.mail` into the container.

> **Status:** 1.0.0-alpha — mail core only.

## Install

```bash
bun add @strav/signal
```

Peer: `@strav/kernel`.

## Minimal example

```ts
// config/mail.ts
import type { MailConfig } from '@strav/signal'

export default {
  default: 'array',                       // or 'log' in dev, 'smtp' once it ships
  from: { email: 'noreply@acme.com', name: 'Acme' },
  transports: {
    array: { driver: 'array' },
    log: { driver: 'log', channel: 'mail' },
  },
} satisfies MailConfig
```

```ts
// in a controller or service
@inject()
class SignupController {
  constructor(private readonly mail: MailManager) {}

  async send(email: string): Promise<void> {
    await this.mail.send({
      to: email,
      subject: 'Welcome',
      html: '<h1>Welcome</h1>',
      text: 'Welcome',
    })
  }
}
```

## Test integration

```ts
await mail.send({ to: 'a@x', subject: 'hi', text: 'h' })
expect((mail.via() as ArrayTransport).messages[0]?.subject).toBe('hi')
```

`ArrayTransport.messages` is a frozen view of every send since the last `clear()`.

## What's NOT here yet

- `Mailable` base class + queue-dispatch sugar (`mail.queue(new WelcomeEmail(user))`).
- Real transports: SMTP, Resend, SendGrid.
- Inbound parsers (Postmark, Mailgun).
- Notifications + channel drivers.
- Broadcast pub/sub + SSE handler.

Full reference: [`docs/signal/api.md`](../../docs/signal/api.md).
