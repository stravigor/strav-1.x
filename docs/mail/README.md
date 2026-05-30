# @strav/mail

Outbound + inbound mail for Strav 1.0. The package covers synchronous send + queued delivery via `Mailable` over four production HTTP transports — Resend, SendGrid, Mailgun, and Alibaba Cloud DirectMail (the SEA-first option) — plus Postmark + Mailgun webhook parsers that normalise inbound webhooks to `ParsedInboundMail`. All pure-fetch — no SDK deps, no `nodemailer`. Notifications, broadcast, and SSE live in `@strav/notification`.

> **Status: 1.0.0-alpha — mail layer + HTTP transports + inbound parsers shipped.** Shipping: `Message` types + `Transport` interface + `ArrayTransport` + `LogTransport` + `ResendTransport` + `SendGridTransport` + `MailgunTransport` + `AlibabaDmTransport` + Postmark / Mailgun inbound webhook parsers + `MailTransportError` + `MailInboundError` + `MailManager` (multi-transport with default-`from` substitution + Mailable-aware `send` overload) + `MailProvider` + `Mailable` base class (Mailables ARE Jobs — dispatch via the standard `Queue.dispatch`).

## Install

```bash
bun add @strav/mail
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
| `AlibabaDmTransport` / `AlibabaDmTransportOptions` | Production HTTP transport for Alibaba Cloud DirectMail (`SingleSendMail`). RPC v1 HMAC-SHA1 signature, region routing via `endpoint` override (global default; ap-southeast-1/-3/-5 for Singapore / KL / Jakarta). SEA-first option — strongest deliverability for Chinese + SEA inboxes. No cc/bcc/attachments — throws non-retryable `MailTransportError` pre-flight if used |
| `MailTransportError` | Typed `StravError` subclass thrown by transports on send failure. `context` carries `provider` / `status` / `retryable` / `providerError` |
| `MailManager` | The public mail surface. Builds + caches one `Transport` per configured entry. `send(message)` routes through the default; `via(name?)` returns a named transport; `shutdown()` closes them |
| `MailConfig` / `MailTransportConfig` | The `config.mail` shape — `{ default, from?, transports }` with `transports: Record<string, MailTransportConfig>` |
| `MailProvider` | Reads `config('mail')`, binds `MailManager` + the `'mail'` alias, calls `shutdown()` on app teardown. Depends on `'config'` + `'logger'` |
| `Mailable<TPayload>` | Typed `Job` subclass. Override `build(payload)` to return a `Message`; the base `handle()` builds + sends via the default transport. Dispatch with `queue.dispatch(YourMailable, payload)` for async delivery, or `mail.send(YourMailable, payload)` for inline sync delivery |
| `MailableClass<TPayload>` / `MailablePayloadOf<T>` | Constructor type + payload extractor — mirrors `JobClass` / `PayloadOf` from `@strav/queue` |

## Minimal example

`config/mail.ts`:

```ts
import type { MailConfig } from '@strav/mail'

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
    alibaba: {
      driver: 'alibaba',
      accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID ?? '',
      accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET ?? '',
      accountName: process.env.ALIBABA_DM_ACCOUNT ?? '',     // verified sender in DM console
      endpoint: 'https://dm.ap-southeast-1.aliyuncs.com',    // Singapore — drop for global
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
import { MailProvider } from '@strav/mail'

export default [
  new ConfigProvider({ app: appConfig, logger: loggerConfig, mail: mailConfig }),
  new LoggerProvider(),
  new MailProvider(),
]
```

Sending:

```ts
import { inject } from '@strav/kernel'
import { MailManager } from '@strav/mail'

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
- [`guides/transports.md`](./guides/transports.md) — picking a transport, multi-transport routing, region overrides (Alibaba SEA, Mailgun EU).
- [`guides/mailables.md`](./guides/mailables.md) — Mailable class, sync vs queued dispatch, failure hooks, payload design.
- [`guides/inbound.md`](./guides/inbound.md) — wiring Postmark + Mailgun webhook routes, the mail-loop guard, threading.
- [`guides/testing.md`](./guides/testing.md) — `ArrayTransport` assertions, faking inbound parsers, deterministic Alibaba signatures.

## Queue-dispatched mail

```ts
import { JobRegistry } from '@strav/queue'
import { Mailable, type Message } from '@strav/mail'

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

Strav 1.x stays pure-fetch. SMTP requires either `nodemailer` (heavyweight) or hand-rolled wire-protocol code over `Bun.connect`. Apps that need SMTP either send through a transactional provider (Resend / SendGrid / Mailgun / Alibaba DirectMail) that fronts the SMTP relay, or write their own `Transport` implementation.

## Inbound webhooks

Two providers ship today: Postmark and Mailgun.

```ts
import { MailgunInboundParser, PostmarkInboundParser } from '@strav/mail'

const postmark = new PostmarkInboundParser()
const mailgun = new MailgunInboundParser({ webhookSigningKey: env.MAILGUN_SIGNING_KEY })
```

Pass the raw request body and lowercased headers — both parsers return the same shape (`ParsedInboundMail`) so application code can stay provider-agnostic:

```ts
const mail = await mailgun.parse({ body: rawBody, headers: req.headers })
if (mail.isAutoGenerated) return                  // RFC 3834 mail-loop guard
await onIncoming(mail)
```

- **Mailgun** verifies HMAC-SHA256 over `(timestamp + token)` with the dashboard's webhook signing key and rejects timestamps older than `maxAgeSeconds` (default 300s). Signature mismatch / stale timestamp throws `AuthError`; non-multipart bodies throw `MailInboundError`.
- **Postmark** does NOT sign inbound webhooks — authenticate the route at the HTTP layer (Basic auth on the webhook URL or IP allow-listing) before handing the body to the parser. Malformed JSON throws `MailInboundError`.

The normalised shape covers what application code actually needs: `from`/`to`/`cc`/`bcc` as `{ address, name? }`, decoded `attachments` as Node `Buffer`, RFC-5322 threading (`messageId`, `inReplyTo`, `references` with angle brackets stripped), and `isAutoGenerated` from `Auto-Submitted` / `Precedence` / `X-Auto-Response-Suppress`.

## What's NOT here yet

- **Notifications** — `BaseNotification` + `Notifiable` mixin + channel drivers (mail, database, webhook, broadcast).
- **Broadcast** — pub/sub primitive + channel auth.
- **SSE** — kernel handler + `AsyncIterable<SSEEvent>` runtime.
