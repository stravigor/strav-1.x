# @strav/notification

Multi-channel notifications for Strav 1.0. One fluent surface — `notifications.send(notifiable, notification)` — that fan-outs to every channel a notification declares. Channel drivers ship under subpaths; new ones register via `manager.extend(name, factory)` from their service provider.

> **Status: 1.0.0-alpha.** `NotificationManager` + `BaseNotification` + four channels shipped: mail (wraps `@strav/mail`), database (`notification` ledger with `unread()` / `markAsRead()`, tenanted variant under `./tenanted`), log (kernel `Logger`), webhook (HMAC-signed JSON POST). Broadcast / Discord / SMS channels ship in follow-up slices.

## Install

```bash
bun add @strav/notification
# Add the channels you need — all are optional peers:
bun add @strav/mail @strav/database
```

## What's here

| Export | Notes |
|---|---|
| `NotificationManager` | The public surface. `send(notifiable, notification)` collects per-channel `NotificationDeliveryResult`s into a single dispatch result; `use(name?)` resolves a channel driver lazily and caches |
| `BaseNotification` | App subclass declaring `via(notifiable): string[]` + per-channel `to<Channel>(notifiable)` hooks. Channels whose hook is absent are skipped without error |
| `Notifiable` | `{ id, notifiableType?, [k]: unknown }` — anything addressable. Apps put `email`, `phone`, preferences, etc. on whatever shape they already use |
| `NotificationProvider` | Wires the manager + reads `config.notification`. Channel adapter providers declare `dependencies: ['notification']` |
| `NotificationDriver` / `NotificationDriverFactory` | The driver contract — `send(notifiable, notification, context)` + `name`. Custom drivers register via `manager.extend('driver-name', factory)` |
| `NotificationError` / `NotificationConfigError` / `UnknownChannelError` / `NotificationDeliveryError` | Typed error hierarchy with stable `code`s apps branch on |
| `MockNotificationDriver` / `mockNotificationDriverFactory` | Test double — records every dispatch in `records`. Wire via `manager.useDriver(name, new MockNotificationDriver())` |

Channel drivers under subpaths:

| Channel | Subpath | Notes |
|---|---|---|
| Mail | `@strav/notification/mail` | Reads `notification.toMail(notifiable): Message`; dispatches via `MailManager.send`. Peer-optional on `@strav/mail` |
| Database | `@strav/notification/database` | Append-only `notification` ledger + `NotificationRepository` (`record` / `unread` / `markAsRead`). Schema registered via `notificationSchema`; migration via `applyNotificationMigration`. Peer-optional on `@strav/database` |
| Database — tenanted | `@strav/notification/tenanted` | Tenanted variant of the database channel — `tenantedNotificationSchema` + `applyTenantedNotificationMigration` + `TenantedNotificationRepository`. RLS-scoped under `TenantManager.withTenant(...)` |
| Log | `@strav/notification/log` | Routes through the kernel `Logger`. Useful for dev + tests where standing up mail/database is overkill |
| Webhook | `@strav/notification/webhook` | POSTs a signed JSON envelope (`x-strav-signature: sha256=…` over `${timestamp}.${body}`) to a configured endpoint. Exports `verifyWebhookSignature` for receiver-side validation |

Deferred: broadcast, Discord, SMS. Apps register custom channels via `manager.extend(name, factory)` and a `dependencies: ['notification']` provider.

## Minimal example

`config/notification.ts`:

```ts
import type { NotificationConfig } from '@strav/notification'

export default {
  channels: {
    mail:     { driver: 'mail' },
    database: { driver: 'database' },
    log:      { driver: 'log', level: 'info' },
    webhook:  {
      driver: 'webhook',
      endpoint: process.env.WEBHOOK_URL ?? '',
      secret:   process.env.WEBHOOK_SECRET ?? '',
    },
  },
} satisfies NotificationConfig
```

`bootstrap/providers.ts`:

```ts
import { ConfigProvider, LoggerProvider } from '@strav/kernel'
import { DatabaseProvider } from '@strav/database'
import { MailProvider } from '@strav/mail'
import { NotificationProvider } from '@strav/notification'
import { MailNotificationProvider } from '@strav/notification/mail'
import { DatabaseNotificationProvider } from '@strav/notification/database'
import { LogNotificationProvider } from '@strav/notification/log'
import { WebhookNotificationProvider } from '@strav/notification/webhook'

import appConfig from '../config/app.ts'
import loggerConfig from '../config/logger.ts'
import databaseConfig from '../config/database.ts'
import mailConfig from '../config/mail.ts'
import notificationConfig from '../config/notification.ts'

export default [
  new ConfigProvider({
    app: appConfig,
    logger: loggerConfig,
    database: databaseConfig,
    mail: mailConfig,
    notification: notificationConfig,
  }),
  new LoggerProvider(),
  new DatabaseProvider(),
  new MailProvider(),
  new NotificationProvider(),
  new MailNotificationProvider(),
  new DatabaseNotificationProvider(),
  new LogNotificationProvider(),
  new WebhookNotificationProvider(),
]
```

Define a notification:

```ts
// app/Notifications/invoice_paid.ts
import { BaseNotification, type Notifiable } from '@strav/notification'
import type { Message } from '@strav/mail'

export class InvoicePaid extends BaseNotification {
  constructor(private readonly payload: { invoiceId: string; amount: number }) {
    super()
  }

  override via(_n: Notifiable): readonly string[] {
    return ['mail', 'database', 'webhook']
  }

  toMail(notifiable: Notifiable): Message {
    return {
      to: notifiable['email'] as string,
      subject: `Invoice ${this.payload.invoiceId} paid`,
      text: `Your payment of ${this.payload.amount} cents has been received.`,
    }
  }

  toDatabase(_n: Notifiable): Record<string, unknown> {
    return { invoiceId: this.payload.invoiceId, amount: this.payload.amount }
  }

  toWebhook(_n: Notifiable): Record<string, unknown> {
    return { invoiceId: this.payload.invoiceId, amount: this.payload.amount }
  }
}
```

Dispatch:

```ts
import { inject } from '@strav/kernel'
import { NotificationManager } from '@strav/notification'
import { InvoicePaid } from '../app/Notifications/invoice_paid.ts'

@inject()
class BillingService {
  constructor(private readonly notifications: NotificationManager) {}

  async paid(user: { id: string; email: string }, invoice: { id: string; amount: number }): Promise<void> {
    const result = await this.notifications.send(
      { id: user.id, email: user.email, notifiableType: 'User' },
      new InvoicePaid({ invoiceId: invoice.id, amount: invoice.amount }),
    )
    // result.deliveries[i] = { channel, delivered, reference?, error? }
    // The manager never re-throws — inspect for partial failures.
  }
}
```

## Dispatch result

```ts
interface NotificationDispatchResult {
  id: string                                      // ULID shared across all channels
  deliveries: readonly NotificationDeliveryResult[]
}

interface NotificationDeliveryResult {
  channel: string                                 // channel name (matches via())
  delivered: boolean
  reference?: string                              // provider-side id when applicable
  error?: Error                                   // capture-don't-throw
}
```

Channel-level throws are captured into `error` — the manager never rethrows. Apps decide whether a partial failure (mail OK, webhook 5xx) is retryable; the dispatch ID + per-channel reference make that traceable.

## Documentation

- [`api.md`](./api.md) — every public export with signatures + semantics.
- [`guides/channels.md`](./guides/channels.md) — picking + configuring channels, per-notifiable preferences, the hook surface per channel, dispatch-result patterns.
- [`guides/persistence.md`](./guides/persistence.md) — database channel deep dive: schema + migration, `unread` / `markAsRead`, the tenanted variant, dual-channel (broadcast + database) for live + persistent.
- [`guides/custom_channels.md`](./guides/custom_channels.md) — building a custom driver + provider end-to-end against a Slack-webhook example.
- [`guides/testing.md`](./guides/testing.md) — `MockNotificationDriver` patterns, asserting fan-out + partial failure, integration tests with real channels.

## Custom channels

Implement `NotificationDriver`, expose a `NotificationDriverFactory`, register via your own ServiceProvider:

```ts
import { NotificationManager, type NotificationDriver } from '@strav/notification'

class SlackNotificationDriver implements NotificationDriver {
  readonly name: string
  constructor(opts: { name: string; webhookUrl: string }) { /* ... */ }
  async send(notifiable, notification, context) { /* ... */ }
}

export class SlackNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.slack'
  override readonly dependencies = ['notification']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    manager.extend('slack', ({ instanceName, config }) =>
      new SlackNotificationDriver({ name: instanceName, webhookUrl: (config as { webhookUrl: string }).webhookUrl })
    )
  }
}
```

The channel config (`config.notification.channels.slack`) is whatever shape the factory consumes — the manager treats it as opaque per-driver state.
