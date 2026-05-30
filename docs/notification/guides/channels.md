# Channels

A notification declares which channels it fans out to via `BaseNotification.via(notifiable)`. The `NotificationManager` reads that list, resolves each channel's driver, and dispatches in order. Channel selection is per-notification, per-notifiable — the same notification class can hit different channels depending on who's receiving it.

## Picking channels

Three patterns cover most apps:

| Shape | Example |
|---|---|
| **Static** — always the same channels | `return ['mail', 'database']` |
| **Per-notifiable preferences** | `return notifiable.preferences.email ? ['mail', 'database'] : ['database']` |
| **Tiered by importance** | `return this.urgent ? ['mail', 'database', 'webhook'] : ['database']` |

The list is a snapshot at dispatch time. If the user's preferences change between dispatch and delivery, the channels won't follow — that's intentional. For preference-driven routing where freshness matters, read the user inside `via()` from a repository the notification has injected.

```ts
@inject()
class CommentReplyNotification extends BaseNotification {
  constructor(
    private readonly prefs: NotificationPreferencesRepository,
    private readonly payload: { commentId: string },
  ) { super() }

  override async via(notifiable: Notifiable): Promise<readonly string[]> {
    // Strav's via() is sync in the type, but BaseNotification accepts a
    // Promise return at runtime — the manager awaits it before fan-out.
    const prefs = await this.prefs.forUser(notifiable.id as string)
    const channels: string[] = ['database']
    if (prefs.mail) channels.push('mail')
    if (prefs.webhook) channels.push('webhook')
    return channels
  }

  toMail(n: Notifiable) { /* ... */ }
  toDatabase(_n: Notifiable) { return { commentId: this.payload.commentId } }
  toWebhook(_n: Notifiable) { return { commentId: this.payload.commentId } }
}
```

The hook method on the BaseNotification — `via(notifiable)` — accepts an async return at runtime. The type signature is `readonly string[]` to keep the common case ergonomic; widen to a Promise in your subclass when you need async preference loading.

## Configuring channels

`config/notification.ts` declares one entry per named channel. The `driver` discriminator selects which channel adapter handles it:

```ts
import type { NotificationConfig } from '@strav/notification'

export default {
  channels: {
    mail:      { driver: 'mail' },
    database:  { driver: 'database' },
    log:       { driver: 'log', level: 'info' },
    webhook:   {
      driver: 'webhook',
      endpoint: process.env.WEBHOOK_URL ?? '',
      secret:   process.env.WEBHOOK_SECRET ?? '',
    },
    broadcast: { driver: 'broadcast' },
    discord:   {
      driver: 'discord',
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
      username:  'Strav',
    },
    sse:       { driver: 'sse' },
  },
} satisfies NotificationConfig
```

The channel name (left of the `:`) is what notifications refer to in `via()`. The `driver` (right side) is what the manager looks up in the extension registry — populated by each channel adapter's ServiceProvider when it calls `manager.extend(driverName, factory)`.

You can register the same driver multiple times under different channel names. Useful for the webhook channel when you have several downstream consumers:

```ts
channels: {
  webhook_billing: {
    driver: 'webhook',
    endpoint: process.env.BILLING_WEBHOOK ?? '',
    secret:   process.env.BILLING_SECRET ?? '',
  },
  webhook_analytics: {
    driver: 'webhook',
    endpoint: process.env.ANALYTICS_WEBHOOK ?? '',
    secret:   process.env.ANALYTICS_SECRET ?? '',
  },
}
```

```ts
class InvoicePaid extends BaseNotification {
  override via(): readonly string[] {
    return ['database', 'webhook_billing', 'webhook_analytics']
  }
  toWebhook(_n: Notifiable) {
    return { invoiceId: this.payload.invoiceId, amount: this.payload.amount }
  }
}
```

Both webhook channels read the same `toWebhook(notifiable)` hook on the notification. If you need different payloads per consumer, give them different driver names (`toBilling` / `toAnalytics`) via a custom driver — see [custom_channels.md](./custom_channels.md).

## Default channel — `default`

`NotificationConfig.default` is optional and only relevant for the `notifications.use(name?)` overload (resolving a single driver without firing a notification). Most apps don't need it — `notifications.send(...)` reads `via()` and never consults the default.

```ts
const driver = notifications.use()              // throws if no default
const driver = notifications.use('mail')        // explicit name
```

The fan-out path is the standard one. `use()` is for code that needs to talk to a specific channel without going through a `BaseNotification` — rare, but useful for system-level dispatches (a health-check ping, a one-off broadcast).

## Hooks

Each channel reads a specific hook on the notification:

| Channel | Hook | Return |
|---|---|---|
| `mail` | `toMail(notifiable)` | `Message` (from `@strav/mail`) |
| `database` | `toDatabase(notifiable)` | `Record<string, unknown>` — JSON-serialisable; lands in the `notification.data` column |
| `log` | `toLog(notifiable)` | `string` (logged as message) or `Record<string, unknown>` (merged into log fields) |
| `webhook` | `toWebhook(notifiable)` | `unknown` — JSON-serialisable; wrapped in the signed envelope |
| `broadcast` | `toBroadcast(notifiable)` | `{ channel, event?, data }` |
| `discord` | `toDiscord(notifiable, defaults)` | `string` (shorthand for `{ content }`) OR `DiscordMessage` (`content`, `embeds`, `components`, `webhookUrl` to override the channel default, etc.) |
| `sse` | `toSSE(notifiable)` | `string` (shorthand for `{ data }`) OR `SSEEvent` (`data`, `event?`, `id?`, `retry?`). Pushed to every active in-process subscriber for `(notifiable.id, notifiable.notifiableType)` |

Hooks are optional. A channel whose hook is absent on the notification returns `{ delivered: false }` without raising — the manager records it in the dispatch result so you can audit "what didn't fire". This is intentional: the same notification can declare `via() === ['mail', 'database', 'broadcast']` and still only implement `toMail` + `toDatabase` because the broadcast variant lives elsewhere or hasn't been written yet.

```ts
class WelcomeEmail extends BaseNotification {
  override via(): readonly string[] {
    return ['mail', 'database']
  }
  toMail(notifiable: Notifiable): Message { /* ... */ }
  // No toDatabase — the database channel returns delivered:false, no throw.
}
```

If you want a "missing hook" to be loud (e.g. you're refactoring channels and want to catch unimplemented ones), assert in the receiver of `dispatchResult.deliveries`:

```ts
const result = await notifications.send(user, new InvoicePaid({ ... }))
for (const delivery of result.deliveries) {
  if (!delivery.delivered && delivery.error === undefined) {
    log.warn('notification channel had no hook', {
      notification: 'InvoicePaid',
      channel: delivery.channel,
    })
  }
}
```

## Routing a single channel — `via(name?)`

`notifications.use(name)` resolves and caches a channel's driver. Useful in two cases:

1. **System-level dispatch** — you want to send through one channel without composing a `BaseNotification` subclass.
2. **Driver-level access** — inspecting per-channel state (e.g. asserting on `ArrayTransport.messages` in tests).

```ts
const driver = notifications.use('webhook_billing')
await driver.send(user, customNotification, { id: ulid(), dispatchedAt: new Date() })
```

Most app code uses `send()` and never touches `use()`. Reach for it when the fan-out shape doesn't fit your use case — not as the default.

## Dispatch result

```ts
interface NotificationDispatchResult {
  id: string                                      // ULID shared across all channels
  deliveries: readonly NotificationDeliveryResult[]
}

interface NotificationDeliveryResult {
  channel: string                                 // matches via()
  delivered: boolean
  reference?: string                              // provider-side id when applicable
  error?: Error                                   // capture-don't-throw
}
```

The `id` is a single ULID for the dispatch — useful as a correlation key in logs, persistence rows (the database channel records it as the row's `id`), and broadcast events (`BroadcastNotificationDriver` threads it as the event's `id`). When the same notification reaches a user across multiple channels, all of them share this ULID so client-side dedup is straightforward.

Channel-level throws are captured into `error` — the manager never rethrows. Apps decide whether a partial failure (mail OK, webhook 5xx) is retryable. The most common pattern is to inspect `error` for `MailTransportError` / `NotificationDeliveryError` and re-dispatch only the failed channels:

```ts
const result = await notifications.send(user, notif)
const failed = result.deliveries
  .filter(d => !d.delivered && d.error !== undefined)
  .map(d => d.channel)

if (failed.length > 0) {
  // Re-dispatch only the failed channels by wrapping in a one-off
  // BaseNotification that returns the failed list from via().
  await retryQueue.dispatch(RetryNotification, {
    originalId: result.id,
    channels: failed,
    payload: notif.payload,
  })
}
```

Or just log and move on — many apps treat notifications as best-effort and don't retry channel failures.

## When NOT to use the manager

The fan-out abstraction is right for notifications — domain events that have meaningful representations across multiple delivery surfaces. It's the wrong tool when:

- **You only need one channel.** Inject `MailManager` / `Broadcaster` directly. The `NotificationManager` doesn't earn its keep when there's nothing to fan out.
- **The "notification" is really a job.** A background email sent because a queue worker decided to (no user-facing notification semantics) is better as a `Mailable` dispatched via `@strav/queue`. The retry / dead-letter machinery is more useful there than the manager's capture-don't-throw.
- **The payload is identical across channels and the channels are decided at config time, not per-call.** A static webhook fanout to N consumers is better wired as N separate publish calls or one notification with custom routing — depending on whether you want per-consumer reliability.

Notifications shine when the same event needs different shapes per channel (email body vs database row vs broadcast event), the channel set depends on the recipient, and you want dispatch correlation across surfaces. When you reach for the manager and find yourself implementing only one `to<Channel>` hook, that's a signal to bypass it.
