# @strav/notification

Multi-channel notifications for Strav 1.0. One fluent surface (`notifications.send(notifiable, notification)`) that fan-outs to ≥1 channel drivers — mail / database / log / webhook / broadcast today; Discord / SMS channels in follow-up slices.

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

Deferred: Discord, SMS channel drivers. Apps register custom channels via `manager.extend(name, factory)`.
