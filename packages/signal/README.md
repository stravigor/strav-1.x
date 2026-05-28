# @strav/signal

Outbound communication for Strav 1.0. Mail layer functionally complete:

- `Message` + `MailRecipient` + `MailAddress` + `MessageAttachment` — the plain-data envelope.
- `Transport` interface — what every backend implements (`send`, optional `close`).
- `ArrayTransport` — in-memory recorder for tests.
- `LogTransport` — writes `mail.sent` records to a `Logger` channel; local-dev default.
- `MailManager` — multi-transport orchestration with default-`from` substitution + Mailable-aware `send` overload + lazy/cached transport build.
- `MailProvider` — wires `config.mail` into the container.
- `Mailable<TPayload>` — typed `Job` subclass; override `build(payload)`, dispatch via `queue.dispatch(YourMailable, payload)` for async delivery with retries / dead-letter.

> **Status:** 1.0.0-alpha — mail layer functionally complete.

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

## Mailable + queue

```ts
import { Mailable, type Message } from '@strav/signal'

class WelcomeEmail extends Mailable<{ name: string }> {
  static override readonly jobName = 'mail.welcome'
  build(payload: { name: string }): Message {
    return { to: `${payload.name}@x`, subject: 'Welcome', text: `Hi ${payload.name}` }
  }
}

// Register with JobRegistry (same as any other Job).
registry.register(WelcomeEmail)

// Dispatch:
await queue.dispatch(WelcomeEmail, { name: 'Alice' })  // async, retried
await mail.send(WelcomeEmail, { name: 'Alice' })       // sync, inline
```

Mailables participate in the full `@strav/queue` lifecycle (retries, backoff, `strav_failed_jobs` dead-letter).

## What's NOT here yet

- Real transports: SMTP, Resend, SendGrid.
- Inbound parsers (Postmark, Mailgun).
- Notifications + channel drivers.
- Broadcast pub/sub + SSE handler.

Full reference: [`docs/signal/api.md`](../../docs/signal/api.md).
