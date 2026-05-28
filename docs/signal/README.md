# @strav/signal

Outbound communication for Strav 1.0. The mail layer is functionally complete in slice 2 — `Message` shape + `Transport` contract + `ArrayTransport` + `LogTransport` + `MailManager` + `MailProvider` + `Mailable<TPayload>` (typed `Job` for queue-dispatched email). Real transports (SMTP / Resend / SendGrid), inbound parsers, notifications, broadcast, and SSE land in subsequent slices.

> **Status: 1.0.0-alpha — mail layer functionally complete.** Shipping: `Message` types + `Transport` interface + `ArrayTransport` + `LogTransport` + `MailManager` (multi-transport with default-`from` substitution + Mailable-aware `send` overload) + `MailProvider` + `Mailable` base class (Mailables ARE Jobs — dispatch via the standard `Queue.dispatch`).

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
| `Mailable<TPayload>` | Typed `Job` subclass. Override `build(payload)` to return a `Message`; the base `handle()` builds + sends via the default transport. Dispatch with `queue.dispatch(YourMailable, payload)` for async delivery, or `mail.send(YourMailable, payload)` for inline sync delivery |
| `MailableClass<TPayload>` / `MailablePayloadOf<T>` | Constructor type + payload extractor — mirrors `JobClass` / `PayloadOf` from `@strav/queue` |

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

## What's NOT here yet

- **Real transports** — SMTP, Resend, SendGrid. Drop-in `Transport` implementations once the underlying SDKs are decided on.
- **Inbound parsers** — Postmark + Mailgun webhook bodies → normalised `InboundMessage`.
- **Notifications** — `BaseNotification` + `Notifiable` mixin + channel drivers (mail, database, webhook, broadcast).
- **Broadcast** — pub/sub primitive + channel auth.
- **SSE** — kernel handler + `AsyncIterable<SSEEvent>` runtime.
