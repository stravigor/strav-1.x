# @strav/signal

Outbound communication for Strav 1.0 — slice 1 ships the **mail core** (`Message` shape + `Transport` contract + `ArrayTransport` + `LogTransport` + `MailManager` + `MailProvider`). Mailable classes, real transports (SMTP / Resend / SendGrid), notifications, broadcast, and SSE land in subsequent slices.

> **Status: 1.0.0-alpha — mail core only.** Shipping: `Message` types + `Transport` interface + `ArrayTransport` + `LogTransport` + `MailManager` (multi-transport with default-`from` substitution) + `MailProvider` (wires `config.mail` into the container).

## Install

```bash
bun add @strav/signal
```

Peer dep: `@strav/kernel`.

## What's here (mail core)

| Symbol | Purpose |
|---|---|
| `Message` / `MailRecipient` / `MailAddress` / `MessageAttachment` | The plain-data envelope every `Transport` accepts. Recipients can be bare strings or `{ email, name? }` pairs. At least one of `html` / `text` must be set |
| `Transport` (interface) | Per-driver contract — `send(message): Promise<void>` + optional `close()` for lifecycle cleanup |
| `ArrayTransport` | In-memory sink for tests. `messages` exposes recorded sends; `clear()` resets between tests. Stores defensive copies so caller-side mutation after `send()` doesn't disturb history |
| `LogTransport` / `LogTransportOptions` | Local-dev sink — writes `mail.sent` records to a `Logger` channel. Bodies excluded by default (set `includeBody: true` to opt in) |
| `MailManager` | The public mail surface. Builds + caches one `Transport` per configured entry. `send(message)` routes through the default; `via(name?)` returns a named transport; `shutdown()` closes them |
| `MailConfig` / `MailTransportConfig` | The `config.mail` shape — `{ default, from?, transports }` with `transports: Record<string, MailTransportConfig>` |
| `MailProvider` | Reads `config('mail')`, binds `MailManager` + the `'mail'` alias, calls `shutdown()` on app teardown. Depends on `'config'` + `'logger'` |

## Minimal example

`config/mail.ts`:

```ts
import type { MailConfig } from '@strav/signal'

export default {
  default: process.env.NODE_ENV === 'test' ? 'array' : 'log',
  from: { email: 'noreply@acme.com', name: 'Acme' },
  transports: {
    array: { driver: 'array' },
    log: { driver: 'log', channel: 'mail' },
  },
} satisfies MailConfig
```

`bootstrap/providers.ts`:

```ts
import appConfig from '../config/app.ts'
import loggerConfig from '../config/logger.ts'
import mailConfig from '../config/mail.ts'
import {
  ConfigProvider,
  LoggerProvider,
} from '@strav/kernel'
import { MailProvider } from '@strav/signal'

export default [
  new ConfigProvider({ app: appConfig, logger: loggerConfig, mail: mailConfig }),
  new LoggerProvider(),
  new MailProvider(),
]
```

Sending:

```ts
import { inject } from '@strav/kernel'
import { MailManager } from '@strav/signal'

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

`from` is filled in from `config.mail.from` automatically; pass `from` per-message to override.

## Documentation

- [`api.md`](./api.md) — every public export with signatures + semantics.

## What's NOT here yet

- **`Mailable` classes** — a typed base class so `class WelcomeEmail extends Mailable<{ userId: string }>` becomes the canonical "an email I want to send" abstraction, and `mail.queue(new WelcomeEmail({ userId }))` dispatches via `@strav/queue`. The queue dep is already satisfied; the abstraction lands in slice 2.
- **Real transports** — SMTP, Resend, SendGrid. Drop-in `Transport` implementations once the underlying SDKs are decided on.
- **Inbound parsers** — Postmark + Mailgun webhook bodies → normalised `InboundMessage`.
- **Notifications** — `BaseNotification` + `Notifiable` mixin + channel drivers (mail, database, webhook, broadcast).
- **Broadcast** — pub/sub primitive + channel auth.
- **SSE** — kernel handler + `AsyncIterable<SSEEvent>` runtime.
