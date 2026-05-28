# @strav/signal — API Reference

> **Status:** Mail core — `Message` + `Transport` + `ArrayTransport` + `LogTransport` + `MailManager` + `MailProvider`. Mailable + real transports + notifications + broadcast + SSE follow in later slices.

## `Message`

```ts
interface Message {
  to: MailRecipient | MailRecipient[]
  from?: MailRecipient                 // filled in from config.mail.from when omitted
  cc?: MailRecipient | MailRecipient[]
  bcc?: MailRecipient | MailRecipient[]
  replyTo?: MailRecipient | MailRecipient[]
  subject: string
  html?: string                        // at least one of html/text required
  text?: string
  headers?: Record<string, string>
  attachments?: MessageAttachment[]
}
```

The wire-shape every `Transport` accepts. Plain data — no driver-specific fields. Transports translate this into their own format (SMTP envelope, Resend JSON, SendGrid v3) on `send()`.

Body rule: at least one of `html` / `text` must be present. The `Transport` interface doesn't enforce this — drivers do, per their provider's constraints. `LogTransport` records `hasHtml` / `hasText` flags so test assertions stay readable.

## `MailRecipient` / `MailAddress`

```ts
interface MailAddress {
  email: string
  name?: string
}

type MailRecipient = string | MailAddress
```

A recipient is either a bare email (`'alice@example.com'`) or a `{ email, name? }` pair. Lists may mix both forms.

## `MessageAttachment`

```ts
interface MessageAttachment {
  filename: string
  content: string | Uint8Array
  contentType?: string                 // defaults to application/octet-stream
  encoding?: 'utf-8' | 'base64'        // defaults to 'utf-8'
}
```

Binary attachments use `Uint8Array`. Text attachments use a UTF-8 `string`. For base64-encoded payloads passed as strings, set `encoding: 'base64'` so transports decode before transmission. Per-driver size limits apply.

## `Transport` (interface)

```ts
interface Transport {
  send(message: Message): Promise<void>
  close?(): void | Promise<void>
}
```

The per-driver contract. `send()` throws on transport-level failure (provider error, invalid envelope, network). `close()` is optional — drivers that hold long-lived resources (connection pool, kept-alive agent) implement it; `MailManager.shutdown()` awaits every cached transport's `close()` best-effort and swallows errors so a misbehaving driver can't block app shutdown.

## `ArrayTransport`

```ts
class ArrayTransport implements Transport {
  send(message: Message): Promise<void>
  get messages(): readonly Message[]   // recorded messages, in send-order
  get count(): number                  // === messages.length
  clear(): void
}
```

In-memory sink for tests. Records a defensive copy of every send, so caller-side mutation after `send()` doesn't disturb recorded history. `clear()` resets between tests.

```ts
const m = new MailManager(arrayOnlyConfig(), logManager)
await m.send({ to: 'a@x', subject: 'hi', text: 'h' })
expect((m.via() as ArrayTransport).messages[0]?.subject).toBe('hi')
```

## `LogTransport`

```ts
class LogTransport implements Transport {
  constructor(opts: LogTransportOptions)
  send(message: Message): Promise<void>
}

interface LogTransportOptions {
  logger: Logger
  level?: 'debug' | 'info'             // default 'info'
  includeBody?: boolean                // default false
}
```

Writes one structured `'mail.sent'` record per send to a `Logger` channel. Local-dev default — `bun dev` prints what would have left the process without touching real mail providers.

Record shape (default):

```ts
logger.info('mail.sent', {
  mail: {
    to,
    from,
    subject,
    hasHtml,                           // true if message.html set
    hasText,                           // true if message.text set
    cc?, bcc?, replyTo?, headers?,
    attachments?: [{ filename, contentType }, ...],  // bytes excluded
  },
})
```

Bodies (`html` / `text`) are excluded by default — logs get noisy and bodies often contain PII. Set `includeBody: true` for local debugging only.

## `MailConfig` / `MailTransportConfig`

```ts
interface MailConfig {
  default: string                                       // key of transports
  from?: MailRecipient                                  // optional default sender
  transports: Record<string, MailTransportConfig>
}

type MailTransportConfig =
  | { driver: 'array' }
  | { driver: 'log'; channel?: string; level?: 'debug' | 'info'; includeBody?: boolean }
```

The shape `config/mail.ts` exports. Validated eagerly by `MailManager` at construction — bad config throws `ConfigError` at provider boot, never at first send.

## `MailManager`

```ts
class MailManager {
  constructor(config: MailConfig, logManager: LogManager)

  send(message: Message): Promise<void>          // routes through default transport
  via(name?: string): Transport                  // resolve a named transport (default if omitted)
  shutdown(): Promise<void>                      // close every cached transport
}
```

The public mail surface. Validates `config` at construction: `default` must be a known transport, every entry must have a known `driver`. Transports are built lazily on first `via(name)` then cached.

**The `from` substitution.** If a `Message` omits `from`, the manager substitutes `config.mail.from` (when set) before handing off to the transport. A `from` already on the message wins — per-message overrides are never overridden. If neither is set, the transport sees `from: undefined` and may throw (per its provider's requirements).

**Multi-transport apps.** Apps with one default + named overrides do:

```ts
await mail.send(message)                         // uses config.default
await mail.via('priority').send(message)         // uses the 'priority' transport
```

The same `Transport` instance is returned across calls — `via()` caches.

## `MailProvider`

```ts
class MailProvider extends ServiceProvider {
  readonly name = 'mail'
  readonly dependencies = ['config', 'logger']
}
```

Reads `config('mail')`, builds a `MailManager`, binds:

- `MailManager` (singleton)
- `'mail'` (string alias, resolves to the same `MailManager`)

`boot()` eagerly constructs the manager so config errors surface during app start, not on the first send call. `shutdown()` calls `MailManager.shutdown()` to close every cached transport — best-effort, swallows errors.

`ConfigProvider` + `LoggerProvider` must be registered before `MailProvider`. The provider declares the dependency, so `Application.start()` orders them automatically.

## Configuration example

```ts
// config/mail.ts
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

```ts
// config/logger.ts
import type { LoggerConfig } from '@strav/kernel'

export default {
  default: 'main',
  level: 'info',
  channels: {
    main: { driver: 'stderr' },
    mail: { driver: 'stderr' },       // separate channel for filterable mail logs
  },
} satisfies LoggerConfig
```

## What this doesn't ship yet

The mail core is the minimum surface for "an app can send mail and tests can assert on what was sent." Still to land in subsequent signal slices:

- **`Mailable`** — typed `Mailable<TPayload>` base class so apps subclass with a `build()` method returning a `Message`. `mail.send(mailable)` builds + sends; `mail.queue(mailable)` dispatches via `@strav/queue` (the dep is already in place).
- **Real transports** — `SmtpTransport` (via nodemailer or a Bun-native SMTP client), `ResendTransport`, `SendGridTransport`.
- **Inbound parsers** — Postmark + Mailgun webhook bodies → normalised `InboundMessage`.
- **Notifications** — `BaseNotification` + `Notifiable` mixin + `notifications` table + channel drivers (mail, database, webhook, broadcast).
- **Broadcast** — pub/sub primitive + channel auth.
- **SSE** — kernel-level handler + `AsyncIterable<SSEEvent>` runtime.
