# @strav/notification

Multi-channel notifications for Strav 1.0. One fluent surface (`notifications.send(notifiable, notification)`) that fan-outs to ≥1 channel drivers — mail / database / log / webhook / broadcast / discord / sse today; SMS channel in a follow-up slice.

```ts
import { BaseNotification, type Notifiable, NotificationManager } from '@strav/notification'

class InvoicePaid extends BaseNotification {
  override via(): readonly string[] {
    return ['mail', 'database']
  }
  toMail(notifiable: Notifiable) {
    return { to: [notifiable.email], subject: 'Invoice paid', text: '...' }
  }
  toDatabase(_notifiable: Notifiable) {
    return { invoiceId: 'inv_42', amount: 4900 }
  }
}

const notifications = container.resolve(NotificationManager)
await notifications.send(alice, new InvoicePaid())
```

Canonical docs live in [`docs/notification/README.md`](../../docs/notification/README.md).

## What ships in v1

| Channel | Subpath | Notes |
|---|---|---|
| Mail | `@strav/notification/mail` | Wraps `@strav/mail`'s `MailManager.send`. |
| Database | `@strav/notification/database` | Append-only `notification` ledger + `NotificationRepository` (`unread()` / `markAsRead()`). Tenanted variant under `@strav/notification/tenanted`. |
| Log | `@strav/notification/log` | Routes through `@strav/kernel`'s `Logger`. Useful for dev + tests. |
| Webhook | `@strav/notification/webhook` | POSTs a signed JSON envelope (`x-strav-signature: sha256=...` over `${timestamp}.${body}`) to a configured endpoint. Exports `verifyWebhookSignature` for receiver-side validation. |
| Broadcast | `@strav/notification/broadcast` | Publishes a `BroadcastEvent` via `@strav/broadcast`'s `Broadcaster`. Pairs with `router.sse(...)` so live UI clients receive the same dispatch. |
| Discord | `@strav/notification/discord` | POSTs `notification.toDiscord(notifiable)` to a Discord webhook URL. Returns a string (shorthand for `{ content }`) or a `DiscordMessage` with `embeds` / `components` / per-message `webhookUrl` override. Per-recipient URLs via `notifiable.discordWebhookUrl`. |
| SSE | `@strav/notification/sse` | In-process pub/sub. Reads `notification.toSSE(notifiable)` and pushes to every active subscriber for that notifiable. HTTP handlers consume subscriptions via `driver.subscribe(id, { notifiableType? })` + `sseResponse()` from `@strav/http`. |

Deferred: SMS channel driver. Apps register custom channels via `manager.extend(name, factory)`.
