# @strav/mail — API Reference

> **Status:** Outbound mail core + `Mailable` queue-dispatch + production HTTP transports (Resend, SendGrid, Mailgun) + Postmark & Mailgun inbound webhook parsers shipped. All pure-fetch (no SDK deps, no nodemailer). Multi-channel notification fan-out lives in `@strav/notification`.

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

## `ResendTransport`

```ts
class ResendTransport implements Transport {
  constructor(opts: ResendTransportOptions)
  send(message: Message): Promise<void>
}

interface ResendTransportOptions {
  apiKey: string                                 // re_...
  endpoint?: string                              // default 'https://api.resend.com'
  fetch?: typeof fetch                           // override for tests
}
```

Sends mail via the Resend HTTP API. POSTs JSON to `{endpoint}/emails` with `Authorization: Bearer {apiKey}`.

**Recipient encoding.** Resend accepts both bare emails and RFC 5322 `"Name <email>"` strings. The transport normalises to the named form when a display name is provided, so structured recipients always render correctly:

```ts
to: { email: 'alice@x', name: 'Alice' }   →   "Alice" <alice@x>
to: 'alice@x'                              →   alice@x
```

Display-name quotes are escaped (`A "Q" Name` → `"A \"Q\" Name"`).

**Attachments.** `content` is base64-encoded before sending; `Uint8Array` and UTF-8 strings both encode; `encoding: 'base64'` strings pass through. The optional `content_type` field is filled in when `MessageAttachment.contentType` is set.

**Failure.** Non-2xx responses throw `MailTransportError` with:

```ts
err.context = {
  provider: 'resend',
  status: 422,
  retryable: false,             // 5xx / 408 / 429 → true, other 4xx → false
  providerError: { name: 'validation_error', message: '...' },
}
```

Network-layer failures (DNS / TCP / TLS) throw `MailTransportError` with `retryable: true` and the original error as `cause`.

The `retryable` flag is informational — the queue Worker's retry policy lives in `Job.maxAttempts` / `Job.backoff`. Apps that want to short-circuit terminal failures inspect the flag from a `failed(ctx)` hook:

```ts
override async failed(ctx: JobFailedContext<{ name: string }>) {
  const err = ctx.error
  if (err instanceof MailTransportError && err.context.retryable === false) {
    // permanent — log + give up
  }
}
```

## `SendGridTransport`

```ts
class SendGridTransport implements Transport {
  constructor(opts: SendGridTransportOptions)
  send(message: Message): Promise<void>
}

interface SendGridTransportOptions {
  apiKey: string                                 // SG....
  endpoint?: string                              // default 'https://api.sendgrid.com'
  fetch?: typeof fetch                           // override for tests
}
```

Sends mail via SendGrid v3. POSTs JSON to `{endpoint}/v3/mail/send`.

**Personalizations.** SendGrid expects a `personalizations` array with structured-recipient objects. The transport puts all recipients into one personalization entry; multi-personalization (per-recipient subject overrides, etc.) isn't surfaced — apps that need it construct their own `Message` per recipient.

**Content order.** SendGrid v3 requires `text/plain` before `text/html` when both are present. The transport orders them automatically.

**Reply-to.** SendGrid v3 single `reply_to`. When a list is passed, the first recipient becomes `reply_to`; the rest are dropped silently (the newer `reply_to_list` field is not modelled until a real user needs it).

**Attachments.** Base64-encoded `content`, `filename`, optional `type`, fixed `disposition: 'attachment'`. Inline attachments (`disposition: 'inline'` with `Content-ID`) are not surfaced — add when an app needs them.

**Failure.** Same shape as `ResendTransport` — `MailTransportError` with `context.provider = 'sendgrid'` and the same `status` / `retryable` / `providerError` fields. SendGrid returns `202 Accepted` on success (empty body); anything else is a failure.

## `MailgunTransport`

```ts
class MailgunTransport implements Transport {
  constructor(opts: MailgunTransportOptions)
  send(message: Message): Promise<void>
}

interface MailgunTransportOptions {
  apiKey: string                                 // Mailgun API key
  domain: string                                 // your Mailgun-verified sending domain
  endpoint?: string                              // default 'https://api.mailgun.net'
  fetch?: typeof fetch                           // override for tests
}
```

Sends mail via Mailgun's HTTP API. POSTs `multipart/form-data` to `{endpoint}/v3/{domain}/messages`.

**Auth.** HTTP Basic with fixed username `"api"` — the transport constructs `Authorization: Basic base64('api:{apiKey}')` internally. Config only collects the key.

**Body shape (FormData, not JSON).** Mailgun is the odd one out:

| Field | Wire form field |
|---|---|
| `from` | `from` (RFC 5322 `"Name <email>"`) |
| `to` / `cc` / `bcc` | comma-separated string |
| `subject` | `subject` |
| `html` / `text` | `html` / `text` |
| `replyTo` | `h:Reply-To` (header form field) |
| `headers['X-…']` | `h:X-…` per entry |
| `attachments` | `Blob` parts on the `attachment` field |

The `h:` prefix is Mailgun's convention for "add this as a real outbound header" — covers both `Reply-To` and any custom `headers` the caller set.

**Attachments — no base64 here.** Resend / SendGrid require base64-encoded strings in JSON; Mailgun takes raw bytes via `multipart/form-data`. The transport wraps `string` / `Uint8Array` content in `Blob` parts directly. `encoding: 'base64'` string inputs ARE decoded first — the wire payload is always the actual file bytes.

**Region routing.** Default endpoint is `https://api.mailgun.net` (US). For EU-region Mailgun accounts override `endpoint` to `https://api.eu.mailgun.net` in config.

**Failure.** Same shape as Resend / SendGrid — `MailTransportError` with `context.provider = 'mailgun'`, plus the same `status` / `retryable` / `providerError` fields.

## `AlibabaDmTransport`

```ts
class AlibabaDmTransport implements Transport {
  constructor(opts: AlibabaDmTransportOptions)
  send(message: Message): Promise<void>
}

interface AlibabaDmTransportOptions {
  accessKeyId: string                            // Alibaba Cloud AccessKey ID
  accessKeySecret: string                        // Alibaba Cloud AccessKey Secret
  accountName: string                            // verified DirectMail sender (set in DM console)
  endpoint?: string                              // default 'https://dm.aliyuncs.com'
  tagName?: string                               // optional DM TagName for every send
  clickTrace?: boolean                           // enable DM click-tracking; default false
  fetch?: typeof fetch                           // override for tests
  now?: () => Date                               // deterministic clock for tests
  nonce?: () => string                           // deterministic SignatureNonce for tests
}
```

Sends mail via Alibaba Cloud DirectMail's `SingleSendMail` RPC API. POSTs `application/x-www-form-urlencoded` to the endpoint URL. Use this for senders deployed inside Alibaba Cloud or targeting Chinese / South-East Asian inboxes — domestic deliverability to QQ, 163, NetEase and SEA-region ISPs is markedly better than Western providers.

**Auth.** RPC v1 signature — HMAC-SHA1 over a percent-encoded, sorted-key canonical query string, keyed by `{accessKeySecret}&`. Computed per request; no SDK dependency.

**Region routing.** DirectMail is region-scoped. Defaults to the global endpoint (`https://dm.aliyuncs.com`); override `endpoint` for SEA deployments:

| Region | Endpoint |
|---|---|
| Singapore | `https://dm.ap-southeast-1.aliyuncs.com` |
| Sydney | `https://dm.ap-southeast-2.aliyuncs.com` |
| Kuala Lumpur | `https://dm.ap-southeast-3.aliyuncs.com` |
| Jakarta | `https://dm.ap-southeast-5.aliyuncs.com` |

**`accountName` vs `message.from`.** DirectMail enforces that every send originate from an `AccountName` pre-registered in the DM console — there is no per-message override of the envelope sender. Configure the verified account on the transport; use `message.from.name` to vary the display name per send.

**Field mapping.**

| `Message` | DM RPC field |
|---|---|
| `to` | `ToAddress` (comma-joined, up to 100) |
| `from.name` | `FromAlias` |
| `subject` | `Subject` |
| `html` / `text` | `HtmlBody` / `TextBody` |
| `replyTo` | `ReplyToAddress=true` + `ReplyAddress` (+ `ReplyAddressAlias`) — first reply-to only |

**Limitations imposed by `SingleSendMail`** — the transport throws `MailTransportError` (non-retryable) before the network round-trip rather than silently dropping data:

- **No cc / bcc.** The API has no cc / bcc fields. Merging into `to` would expose recipient addresses to each other — send a separate message per recipient set instead.
- **No attachments.** Use SMTP relay or `BatchSendMail` with a template-uploaded file if you need attachments.
- **No custom headers.** `message.headers` is silently dropped. Use the `tagName` option for tagging — DM's analytics consume `TagName`, not arbitrary headers.

**Failure.** Same shape as Resend / SendGrid / Mailgun — `MailTransportError` with `context.provider = 'alibaba'`, plus `status` / `retryable` / `providerError`. DM error bodies are JSON of the form `{ Code, Message, RequestId, HostId }` and land verbatim in `context.providerError`.

## `MailTransportError`

```ts
class MailTransportError extends StravError {
  readonly code: 'mail-transport-error'
  readonly status: 502                                       // fixed
  readonly context: Readonly<Record<string, unknown>>        // see below
}
```

The typed error every HTTP transport throws on failure. `status: 502` reflects "an upstream mail provider failed" from Strav's perspective; the provider's own HTTP status (if any) lives under `context.status`.

`context` shape (depends on the failure mode):

| Failure | `context.provider` | `context.status` | `context.retryable` | `context.providerError` | `error.cause` |
|---|---|---|---|---|---|
| Non-2xx HTTP | provider name | provider's status | per heuristic | parsed JSON body or text | — |
| Network error | provider name | — | `true` | — | original `Error` |
| Pre-flight validation | provider name | — | `false` | — | — |

Use `error instanceof MailTransportError` to discriminate; `isStravError(err)` works too.

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
  | { driver: 'resend'; apiKey: string; endpoint?: string }
  | { driver: 'sendgrid'; apiKey: string; endpoint?: string }
  | { driver: 'mailgun'; apiKey: string; domain: string; endpoint?: string }
  | {
      driver: 'alibaba'
      accessKeyId: string
      accessKeySecret: string
      accountName: string
      endpoint?: string
      tagName?: string
      clickTrace?: boolean
    }
```

Each driver's required fields are validated at construction — empty `apiKey` (Resend / SendGrid / Mailgun), missing `domain` (Mailgun), missing `accessKeyId` / `accessKeySecret` / `accountName` (Alibaba) all throw `ConfigError` at provider boot, never at first send. Pull credentials from env vars in `config/mail.ts`; never hard-code them.

The shape `config/mail.ts` exports. Validated eagerly by `MailManager` at construction — bad config throws `ConfigError` at provider boot, never at first send.

## `MailManager`

```ts
class MailManager {
  constructor(
    config: MailConfig,
    logManager: LogManager,
    container?: Container,                       // required for the Mailable overload
  )

  send(message: Message): Promise<void>          // routes through default transport
  send<T extends MailableClass>(MailableClass: T, payload: MailablePayloadOf<T>): Promise<void>
  via(name?: string): Transport                  // resolve a named transport (default if omitted)
  shutdown(): Promise<void>                      // close every cached transport
}
```

The public mail surface. Validates `config` at construction: `default` must be a known transport, every entry must have a known `driver`. Transports are built lazily on first `via(name)` then cached.

**The two `send` overloads.**

```ts
await mail.send({ to: 'a@x', subject: 'hi', text: 'h' })        // raw Message
await mail.send(WelcomeEmail, { userId: 'u-1' })                 // build via Mailable
```

The Mailable overload constructs the subclass via the `Container` (so `@inject()` deps resolve the same way the queue Worker resolves them), calls `build(payload)`, then sends the resulting `Message` through the default transport. Apps using `MailProvider` get the container wired automatically; constructing `MailManager` by hand without one and then calling the Mailable overload throws `ConfigError`.

**The `from` substitution.** If a `Message` omits `from`, the manager substitutes `config.mail.from` (when set) before handing off to the transport. A `from` already on the message wins — per-message overrides are never overridden. If neither is set, the transport sees `from: undefined` and may throw (per its provider's requirements). Applies to Mailable-built messages too.

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

## `Mailable<TPayload>`

```ts
@inject()
abstract class Mailable<TPayload = unknown> extends Job<TPayload> {
  constructor(protected readonly mail: MailManager)
  abstract build(payload: TPayload): Message | Promise<Message>
  handle(context: JobContext<TPayload>): Promise<void>   // base impl: build + mail.send
}

interface MailableClass<TPayload = unknown> {
  new (...args: any[]): Mailable<TPayload>
  readonly jobName: string                               // inherited from Job
}

type MailablePayloadOf<T> = T extends MailableClass<infer P> ? P : never
```

A typed `Job` that builds and sends a mail message. Subclasses override `build(payload)` to produce a `Message`; the base class's `handle()` implementation calls `build()` then `mail.send(message)`.

Mailables ARE Jobs — they participate in the full job lifecycle (retries, backoff, abort-aware shutdown, `failed()` hook, dead-letter via `strav_failed_jobs`). There is no separate `MailableRegistry`: mailables register with the same `JobRegistry` apps use for any other Job:

```ts
const registry = new JobRegistry().register(WelcomeEmail)
```

### Defining a Mailable

Simple — no extra deps:

```ts
import { Mailable } from '@strav/mail'

class WelcomeEmail extends Mailable<{ name: string }> {
  static override readonly jobName = 'mail.welcome'

  build(payload: { name: string }): Message {
    return {
      to: `${payload.name.toLowerCase()}@example.com`,
      subject: `Welcome, ${payload.name}`,
      text: `Hi ${payload.name} — thanks for signing up.`,
    }
  }
}
```

The subclass inherits `Mailable`'s `@inject()` metadata + constructor, so `container.make(WelcomeEmail)` resolves `MailManager` automatically.

With extra deps:

```ts
import { inject } from '@strav/kernel'
import { Mailable, MailManager } from '@strav/mail'

@inject()
class InvoiceEmail extends Mailable<{ userId: string }> {
  static override readonly jobName = 'mail.invoice'
  constructor(
    mail: MailManager,
    private readonly users: UserRepository,
  ) {
    super(mail)
  }

  async build({ userId }: { userId: string }): Promise<Message> {
    const user = await this.users.findOrFail(userId)
    return { to: user.email, subject: 'Your invoice', text: `Hi ${user.name}` }
  }
}
```

Subclass adds `@inject()` + a constructor listing all deps + calls `super(mail)`.

### Dispatching

```ts
// Sync — no queue hop:
await mail.send(WelcomeEmail, { name: 'Alice' })

// Async — through the queue, with retries / dead-letter:
await queue.dispatch(WelcomeEmail, { name: 'Alice' })
```

The sync path constructs the Mailable via the container, calls `build()`, sends. No persistence. Use it inside request handlers when the latency budget allows an inline send.

The async path is the standard `Queue.dispatch` — no Mailable-specific code. The Worker picks up the row, constructs the Mailable, runs `handle()` (which calls `build()` then `mail.send()`). On failure, the standard retry + backoff + dead-letter machinery applies — Mailables don't bypass the queue's failure semantics.

### Per-attempt config

Inherited from `Job` — set as static overrides:

```ts
class WelcomeEmail extends Mailable<{ name: string }> {
  static override readonly jobName = 'mail.welcome'
  static override readonly maxAttempts = 3
  static override readonly queue = 'mail'           // route to a dedicated queue
  static override readonly timeout = 30             // seconds per attempt
}
```

### Failure hook

Inherited too — `failed(ctx)` fires on each failed attempt + once on terminal failure:

```ts
class WelcomeEmail extends Mailable<{ name: string }> {
  static override readonly jobName = 'mail.welcome'
  async build(payload) { ... }
  override async failed(ctx: JobFailedContext<{ name: string }>) {
    ctx.log.error('welcome-email failed', { name: ctx.payload.name, error: ctx.error })
  }
}
```

## Configuration example

```ts
// config/mail.ts
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
  },
} satisfies MailConfig
```

The empty-string `apiKey` / `domain` fallbacks fail fast: if production starts without the env vars wired in, the `MailManager` constructor throws `ConfigError` at provider boot — better than discovering the missing env var on the first send.

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

## Inbound webhooks

Provider webhooks normalise to a single `ParsedInboundMail` shape so application code stays provider-agnostic.

### `ParsedInboundMail`

```ts
interface ParsedInboundMail {
  from: ParsedInboundAddress
  to: ParsedInboundAddress[]
  cc: ParsedInboundAddress[]
  bcc: ParsedInboundAddress[]
  replyTo?: ParsedInboundAddress
  subject: string
  text?: string
  html?: string
  date?: Date
  headers: Record<string, string>            // lowercased names; last value wins on duplicates
  attachments: ParsedInboundAttachment[]
  messageId?: string                          // RFC 5322 Message-ID, angle brackets stripped
  inReplyTo?: string                          // angle brackets stripped
  references: string[]                        // each element has angle brackets stripped
  isAutoGenerated: boolean                    // honor before any auto-reply — mail-loop guard
  providerMessageId?: string                  // e.g. Postmark MessageID
}

interface ParsedInboundAddress {
  address: string
  name?: string
}

interface ParsedInboundAttachment {
  filename: string
  contentType: string
  content: Buffer
  size: number
  cid?: string                                // Content-ID for inline images, brackets stripped
}
```

### `InboundWebhookInput` / `InboundWebhookParser`

```ts
interface InboundWebhookInput {
  body: string | Buffer                       // Buffer preferred — signature checks need exact bytes
  headers: Record<string, string | undefined> // keys MUST be lowercased
}

interface InboundWebhookParser {
  parse(input: InboundWebhookInput): Promise<ParsedInboundMail>
}
```

### `PostmarkInboundParser`

```ts
import { PostmarkInboundParser } from '@strav/mail'

const parser = new PostmarkInboundParser()
const mail = await parser.parse({ body: rawJsonBody, headers: req.headers })
```

Postmark does NOT sign inbound webhooks. Protect the webhook URL at the HTTP layer (Basic auth, IP allow-list) before invoking `parse()`.

- Throws `MailInboundError` on malformed JSON.
- Reads RFC-5322 `Message-Id` from `Headers[]`; `payload.MessageID` is exposed as `providerMessageId`.
- Decodes base64 `Attachments[].Content` into `Buffer`.

### `MailgunInboundParser`

```ts
import { MailgunInboundParser } from '@strav/mail'

const parser = new MailgunInboundParser({
  webhookSigningKey: env.MAILGUN_SIGNING_KEY,  // distinct from the sending API key
  maxAgeSeconds: 300,                          // default 300 — replay window
})

const mail = await parser.parse({ body: rawMultipartBody, headers: req.headers })
```

- Throws `ConfigError` if `webhookSigningKey` is empty.
- Throws `MailInboundError` if `content-type` is not `multipart/*` or the body is unparseable.
- Throws `AuthError` on missing signature/token/timestamp, signature mismatch, or timestamps outside the replay window.
- Signature verification is constant-time (`crypto.timingSafeEqual`).
- Walks `attachment-count` + `attachment-N` fields and reads multipart parts as `Buffer`.

### `isAutoGeneratedMessage(headers)`

```ts
import { isAutoGeneratedMessage } from '@strav/mail'
```

True when any of `Auto-Submitted` (≠ `no`), `Precedence: bulk|junk|list`, or `X-Auto-Response-Suppress` is set. Honour this before any auto-reply path — skipping it creates mail loops.

### `MailInboundError`

`StravError` subclass — `code: 'mail-inbound-error'`, `status: 400`. Raised when the webhook payload itself is malformed. Signature / signing-key failures use `AuthError`; misconfiguration uses `ConfigError`.

## What this doesn't ship yet

The mail layer covers synchronous + queued + production HTTP delivery across four transports (Resend, SendGrid, Mailgun, Alibaba DirectMail) plus Postmark + Mailgun inbound webhook parsers. All pure-fetch, no SDK deps, no `nodemailer`.

**No SMTP transport.** SMTP requires either a heavyweight Node-stdlib dep (`nodemailer`) or hand-rolled wire-protocol code over `Bun.connect`. Strav 1.x deliberately stays pure-fetch — apps that need SMTP send through a transactional provider (Resend / SendGrid / Mailgun) that fronts the SMTP relay for them, or write their own `Transport` implementation.

Still to land:

- **Notifications** — `BaseNotification` + `Notifiable` mixin + `notifications` table + channel drivers (mail, database, webhook, broadcast).
- **Broadcast** — pub/sub primitive + channel auth.
- **SSE** — kernel-level handler + `AsyncIterable<SSEEvent>` runtime.
