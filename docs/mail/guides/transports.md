# Transports

A `Transport` is the driver behind `mail.send()`. `@strav/mail` ships four production HTTP transports plus two test/dev helpers; you pick which one runs by name in `config/mail.ts`. The contract — `send(message): Promise<void>` plus an optional `close()` — is small, so writing your own transport for a niche provider is the escape hatch.

## Picking a transport

| Driver | Use it when |
|---|---|
| `array` | Tests — every send is recorded in memory; the suite asserts on the array, no network calls. |
| `log` | Local dev — sends are written to a `Logger` channel so you can see what *would* go out without a provider account. |
| `resend` | Modern transactional, US/EU. Clean JSON API, fast onboarding. |
| `sendgrid` | Established transactional. Pick this if you already run on SendGrid; otherwise the others are friendlier. |
| `mailgun` | Transactional with strong EU-region support (`api.eu.mailgun.net`). Multipart wire format — attachments stay raw bytes, no base64 overhead. |
| `alibaba` | **SEA-first.** Strongest deliverability into Chinese inboxes (QQ, 163, NetEase) and South-East Asian regional ISPs. Region-scoped — pick the right endpoint. |

All four production transports are pure-fetch — no SDK dependency, no `nodemailer`. Outbound credentials live in env vars; never hard-code them in `config/mail.ts`.

## Configuring

`config/mail.ts` declares one entry per transport you want available, plus the default to use when `mail.send()` doesn't name one:

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
  },
} satisfies MailConfig
```

The validation runs at `MailProvider` boot: an unknown driver, a missing `default`, or an empty `apiKey` (or `domain`, or Alibaba `accessKeyId` / `accessKeySecret` / `accountName`) throws `ConfigError` immediately. Bad config never makes it to the first send.

## Default `from`

`config.mail.from` is the sender used when a `Message` omits one — keeps controllers from repeating `noreply@acme.com` on every send. Per-message `from` wins; the manager never overwrites a `from` the caller already set.

```ts
await mail.send({ to: 'a@x', subject: 'Welcome', text: 'Hi' })
// ↑ goes out as Acme <noreply@acme.com>

await mail.send({ to: 'a@x', from: 'admin@acme.com', subject: '...', text: '...' })
// ↑ goes out as admin@acme.com — caller's `from` wins
```

If neither config nor message has a `from`, every production transport throws a non-retryable `MailTransportError` before the network round-trip.

## Multiple transports + `via(name)`

Apps that route different traffic through different providers register every transport once and pick per-send:

```ts
transports: {
  default: { driver: 'resend', apiKey: process.env.RESEND_API_KEY ?? '' },
  bulk:    { driver: 'sendgrid', apiKey: process.env.SENDGRID_API_KEY ?? '' },
  cn:      {
    driver: 'alibaba',
    accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID ?? '',
    accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET ?? '',
    accountName: process.env.ALIBABA_DM_ACCOUNT ?? '',
  },
},
```

```ts
// Default — uses config.default.
await mail.send({ to: user.email, ... })

// Route a marketing blast through SendGrid.
await mail.via('bulk').send({ to: list, ... })

// Route to a Chinese inbox via DirectMail.
await mail.via('cn').send({ to: '...@qq.com', ... })
```

`via(name)` lazily constructs the transport the first time you call it and caches the instance — subsequent `via('cn')` calls return the same object. `mail.shutdown()` closes all cached transports best-effort at app shutdown.

## Region routing

Two transports are region-aware via the `endpoint` override:

**Mailgun** — US by default; EU customers override:

```ts
mailgun: {
  driver: 'mailgun',
  apiKey: process.env.MAILGUN_API_KEY ?? '',
  domain: process.env.MAILGUN_DOMAIN ?? '',
  endpoint: 'https://api.eu.mailgun.net',
},
```

**Alibaba DirectMail** — global by default; SEA deployments pick the regional endpoint. The right region is the one your DirectMail account is registered in, not the one closest to your recipients:

| Region | Endpoint |
|---|---|
| Singapore | `https://dm.ap-southeast-1.aliyuncs.com` |
| Sydney | `https://dm.ap-southeast-2.aliyuncs.com` |
| Kuala Lumpur | `https://dm.ap-southeast-3.aliyuncs.com` |
| Jakarta | `https://dm.ap-southeast-5.aliyuncs.com` |

## Alibaba DirectMail — what it can't do

`SingleSendMail` is the right primitive for transactional mail but it doesn't cover everything a Western provider does. The transport throws `MailTransportError` (non-retryable) before sending rather than silently dropping data:

- **No cc / bcc.** Multiple `to` works (comma-joined, up to 100), but cc and bcc are not API parameters. Splitting a "to + cc" send into two sends is the correct workaround — merging cc into `to` would expose recipients to each other.
- **No attachments.** Use SMTP relay or `BatchSendMail` with a template-uploaded file if you must attach.
- **No custom headers.** `message.headers` is dropped. Use the `tagName` option for the common "tag every send" case — DM's analytics consume `TagName`, not arbitrary headers.

Also: the envelope sender (`AccountName`) is on the transport config, not the message. DirectMail enforces that every send originates from a pre-registered account; vary display names per send via `message.from.name`.

## Errors

Every production transport throws `MailTransportError` (a `StravError` subclass) on failure. The `context` field tells you what happened without parsing message strings:

```ts
try {
  await mail.send({ to: 'a@x', subject: '...', text: '...' })
} catch (err) {
  if (err instanceof MailTransportError) {
    err.context.provider     // 'resend' | 'sendgrid' | 'mailgun' | 'alibaba'
    err.context.status       // provider's HTTP status (when applicable)
    err.context.retryable    // boolean — hint for retry policy
    err.context.providerError // parsed provider body, if any
  }
  throw err
}
```

The `retryable` hint follows HTTP semantics: 5xx + network errors are retryable, 408 + 429 are retryable, other 4xx are permanent. The `Queue` worker doesn't read this directly — retry policy lives on `Job.maxAttempts` / `Job.backoff` — but it's there for logging and for human triage from the `strav_failed_jobs` table.

## Writing a custom transport

The `Transport` interface is two methods, one optional:

```ts
import type { Transport, Message } from '@strav/mail'
import { MailTransportError } from '@strav/mail'

export class MyTransport implements Transport {
  async send(message: Message): Promise<void> {
    const res = await fetch('https://my-provider/send', { ... })
    if (res.ok) return
    throw new MailTransportError(`Provider rejected (HTTP ${res.status}).`, {
      context: {
        provider: 'my-provider',
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
        providerError: await res.json().catch(() => undefined),
      },
    })
  }

  async close(): Promise<void> {
    // Free pooled resources if any. Optional.
  }
}
```

Instantiate it directly and hand it to `MailManager`, or — more commonly — extend `MailTransportConfig` in your app code and wire the construction in your own `MailProvider` subclass. The shipped `MailManager` only knows the built-in `driver` strings; the rest is yours.
