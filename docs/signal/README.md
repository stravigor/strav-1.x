# @strav/signal

Outbound communication for Strav 1.0. The mail layer covers synchronous send + queued delivery via `Mailable` + three production HTTP transports (Resend, SendGrid, Mailgun). All pure-fetch — no SDK deps, no `nodemailer`. Inbound parsers, notifications, broadcast, and SSE land in subsequent slices.

> **Status: 1.0.0-alpha.7 — mail layer + HTTP transport trio shipped.** Shipping: `Message` types + `Transport` interface + `ArrayTransport` + `LogTransport` + `ResendTransport` + `SendGridTransport` + `MailgunTransport` + `MailTransportError` + `MailManager` (multi-transport with default-`from` substitution + Mailable-aware `send` overload) + `MailProvider` + `Mailable` base class (Mailables ARE Jobs — dispatch via the standard `Queue.dispatch`).

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
| `ResendTransport` / `ResendTransportOptions` | Production HTTP transport for [Resend](https://resend.com). POSTs JSON to `/emails` with Bearer auth. Throws `MailTransportError` on non-2xx |
| `SendGridTransport` / `SendGridTransportOptions` | Production HTTP transport for SendGrid v3. POSTs to `/v3/mail/send`; expects `202 Accepted` |
| `MailgunTransport` / `MailgunTransportOptions` | Production HTTP transport for Mailgun. POSTs `multipart/form-data` to `/v3/{domain}/messages` with Basic auth. Region routing via `endpoint` override (US default, EU available) |
| `MailTransportError` | Typed `StravError` subclass thrown by transports on send failure. `context` carries `provider` / `status` / `retryable` / `providerError` |
| `MailManager` | The public mail surface. Builds + caches one `Transport` per configured entry. `send(message)` routes through the default; `via(name?)` returns a named transport; `shutdown()` closes them |
| `MailConfig` / `MailTransportConfig` | The `config.mail` shape — `{ default, from?, transports }` with `transports: Record<string, MailTransportConfig>` |
| `MailProvider` | Reads `config('mail')`, binds `MailManager` + the `'mail'` alias, calls `shutdown()` on app teardown. Depends on `'config'` + `'logger'` |
| `Mailable<TPayload>` | Typed `Job` subclass. Override `build(payload)` to return a `Message`; the base `handle()` builds + sends via the default transport. Dispatch with `queue.dispatch(YourMailable, payload)` for async delivery, or `mail.send(YourMailable, payload)` for inline sync delivery |
| `MailableClass<TPayload>` / `MailablePayloadOf<T>` | Constructor type + payload extractor — mirrors `JobClass` / `PayloadOf` from `@strav/queue` |

## Minimal example

`config/mail.ts`:

```ts
import type { MailConfig } from '@strav/signal'

function defaultTransport(): string {
  if (process.env.NODE_ENV === 'test') return 'array'
  if (process.env.NODE_ENV === 'production') return 'resend'
  return 'log'
}

export default {
  default: defaultTransport(),
  from: { email: 'noreply@acme.com', name: 'Acme' },
  transports: {
    array: { driver: 'array' },
    log: { driver: 'log', channel: 'mail' },
    resend: { driver: 'resend', apiKey: process.env.RESEND_API_KEY ?? '' },
    sendgrid: { driver: 'sendgrid', apiKey: process.env.SENDGRID_API_KEY ?? '' },
    mailgun: {
      driver: 'mailgun',
      apiKey: process.env.MAILGUN_API_KEY ?? '',
      domain: process.env.MAILGUN_DOMAIN ?? '',
    },
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

## Queue-dispatched mail

```ts
import { JobRegistry } from '@strav/queue'
import { Mailable, type Message } from '@strav/signal'

class WelcomeEmail extends Mailable<{ name: string }> {
  static override readonly jobName = 'mail.welcome'

  build(payload: { name: string }): Message {
    return {
      to: `${payload.name.toLowerCase()}@example.com`,
      subject: `Welcome, ${payload.name}`,
      text: `Hi ${payload.name}!`,
    }
  }
}

// At startup:
app.singleton(JobRegistry, () => new JobRegistry().register(WelcomeEmail))

// In a controller:
await queue.dispatch(WelcomeEmail, { name: 'Alice' })  // Worker handles it
// OR inline:
await mail.send(WelcomeEmail, { name: 'Alice' })       // sync — no queue
```

Mailables ARE Jobs — they participate in the full job lifecycle (retries, backoff, abort-aware shutdown, `failed()` hook, `strav_failed_jobs` dead-letter). See [`api.md`](./api.md) for the full Mailable reference.

## No SMTP transport

Strav 1.x stays pure-fetch. SMTP requires either `nodemailer` (heavyweight) or hand-rolled wire-protocol code over `Bun.connect`. Apps that need SMTP either send through a transactional provider (Resend / SendGrid / Mailgun) that fronts the SMTP relay, or write their own `Transport` implementation.

## What's NOT here yet

- **Inbound parsers** — Postmark + Mailgun webhook bodies → normalised `InboundMessage`.
- **Notifications** — `BaseNotification` + `Notifiable` mixin + channel drivers (mail, database, webhook, broadcast).
- **Broadcast** — pub/sub primitive + channel auth.
- **SSE** — kernel handler + `AsyncIterable<SSEEvent>` runtime.
