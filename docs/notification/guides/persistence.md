# Persistence

The database channel turns a notification into a row in the `notification` ledger. That ledger is what powers in-app inboxes — "you have 3 unread notifications", the badge in the corner, the dropdown of recent activity. This guide covers wiring the ledger, querying it, and the tenanted variant.

## Wiring

Two boot-time pieces beyond the channel registration:

1. **Schema registration.** Register `notificationSchema` with your `SchemaRegistry` so `generateMigration` picks it up and the Repository can resolve column metadata.
2. **Migration.** Call `applyNotificationMigration` from a migration's `up()`. It emits the table DDL plus a partial index optimised for the unread query.

```ts
// bootstrap/providers.ts
import {
  notificationSchema,
  DatabaseNotificationProvider,
} from '@strav/notification/database'

export default [
  // ... ConfigProvider, LoggerProvider, DatabaseProvider, NotificationProvider, MailProvider, …
  new SchemaRegistryProvider({
    schemas: [notificationSchema /* + your app schemas */],
  }),
  new DatabaseNotificationProvider(),
]
```

```ts
// migrations/<timestamp>_create_notification.ts
import { applyNotificationMigration } from '@strav/notification/database'

export const migration: Migration = {
  name: '20260601000000_create_notification',
  async up(db) {
    await applyNotificationMigration(db, { registry })
  },
  async down(db) {
    await db.execute('DROP TABLE IF EXISTS "notification"')
  },
}
```

The migration creates:

- The `notification` table (id, notifiable_id, notifiable_type, type, data jsonb, read_at, created_at, updated_at).
- A partial index: `(notifiable_id, created_at DESC) WHERE read_at IS NULL`. This is what `unread(notifiable)` hits — small and tight even on tables with millions of historical notifications.

## Row shape

```ts
class NotificationRecord extends Model {
  id!: string                                     // ULID — matches NotificationContext.id
  notifiable_id!: string                          // the recipient's id (stringified)
  notifiable_type!: string                        // notifiable.notifiableType ?? 'Notifiable'
  type!: string                                   // notification.constructor.name
  data!: Record<string, unknown>                  // toDatabase(notifiable) returned this
  read_at!: Date | null                           // null until markAsRead(id)
  created_at!: Date
  updated_at!: Date
}
```

The `id` is the shared dispatch ULID — every channel in the fan-out uses the same one. That means if a notification went out via mail + database + broadcast, the database row's `id` matches the broadcast event's `id` matches the mail's `Message-ID` thread. Use it as the de-dup key on the client side.

`notifiable_type` defaults to `'Notifiable'` when the notifiable doesn't declare one. Most apps set it explicitly:

```ts
const alice: Notifiable = {
  id: user.id,
  email: user.email,
  notifiableType: 'User',
}
```

A consistent `notifiable_type` lets you filter "all notifications for any User" vs "all notifications for any Team" without depending on the id format.

## The Repository

```ts
class NotificationRepository extends Repository<NotificationRecord> {
  async record(input: RecordInput): Promise<NotificationRecord>
  async unread(notifiable: Notifiable): Promise<NotificationRecord[]>
  async markAsRead(id: string): Promise<NotificationRecord | undefined>
}
```

Three methods cover ~95% of inbox UIs.

### `record(input)`

The driver calls this on every database-channel dispatch. Apps usually don't invoke it directly — fire notifications via `NotificationManager.send()` and let the driver insert.

The one case where direct calls make sense: backfilling historical rows. If you're migrating from another notification system, write a one-off script that loops your old data and calls `repo.record(...)` for each. The shape is intentionally narrow so backfills are mechanical.

### `unread(notifiable)`

Returns every unread row for a recipient, ordered newest-first. This is the badge query — hits the partial index, completes in single-digit milliseconds even on tables with millions of read rows.

```ts
@inject()
class InboxController {
  constructor(private readonly notifications: NotificationRepository) {}

  async badge(ctx: HttpContext): Promise<Response> {
    const user = ctx.auth.user
    const unread = await this.notifications.unread({ id: user.id, notifiableType: 'User' })
    return ctx.response.ok({ count: unread.length })
  }
}
```

For large inboxes (a user with 10k unread items because they ignored the badge for a year), pull the count separately rather than fetching every row:

```ts
const { count } = await db.queryOne<{ count: number }>(
  `SELECT count(*)::int AS count FROM notification
   WHERE notifiable_id = $1 AND read_at IS NULL`,
  [String(user.id)],
) ?? { count: 0 }
```

`unread()` is shaped for "render the dropdown" — small results, full row data. For "render a number", the raw query is faster.

### `markAsRead(id)`

Flips `read_at` from null to `now()`. Returns the updated row, or `undefined` if the id doesn't exist.

```ts
async readAll(ctx: HttpContext): Promise<Response> {
  await db.execute(
    `UPDATE notification SET read_at = now(), updated_at = now()
     WHERE notifiable_id = $1 AND read_at IS NULL`,
    [String(ctx.auth.user.id)],
  )
  return ctx.response.noContent()
}
```

The Repository surface doesn't expose a bulk-mark-read because the SQL is one line and apps almost always want different scoping ("mark this group of N as read", "mark everything older than X as read"). Reach for `db.execute` directly.

## Querying beyond the helpers

For richer inbox UIs — filtering by `type`, grouping by day, paginating — write the query directly. The Repository is `unread` + `markAsRead`, not a general inbox API:

```ts
// Paginated history (read + unread), most recent first.
async historyPage(
  notifiable: Notifiable,
  cursor: string | undefined,
  limit = 50,
): Promise<NotificationRecord[]> {
  const rows = await this.db.query<Record<string, unknown>>(
    `SELECT * FROM notification
     WHERE notifiable_id = $1
       AND (created_at < (SELECT created_at FROM notification WHERE id = $2) OR $2::text IS NULL)
     ORDER BY created_at DESC
     LIMIT $3`,
    [String(notifiable.id), cursor ?? null, limit],
  )
  return rows.map(r => this.hydrate(r))
}
```

`this.hydrate(r)` converts a raw row to a `NotificationRecord` instance — same path the Repository's built-in finders use, so jsonb deserialisation + Date parsing are handled.

## The tenanted variant

Multi-tenant apps register `@strav/notification/tenanted` instead of (or alongside) the non-tenanted variant. The schema adds a `tenant_id` column with an RLS policy that limits SELECT / INSERT / UPDATE to the current session's tenant.

```ts
import {
  tenantedNotificationSchema,
  applyTenantedNotificationMigration,
} from '@strav/notification/tenanted'

// bootstrap/providers.ts
new SchemaRegistryProvider({
  schemas: [tenantedNotificationSchema /* + your app schemas */],
}),
```

```ts
// migrations/<timestamp>_create_tenanted_notification.ts
await applyTenantedNotificationMigration(db, { registry })
```

The driver is the same `DatabaseNotificationProvider` — but the repository it consumes needs to be the tenanted variant. Apps that use tenanted notifications hand-wire:

```ts
import { TenantedNotificationRepository } from '@strav/notification/tenanted'
import { DatabaseNotificationDriver } from '@strav/notification/database'

// Custom provider that registers the database channel against the
// tenanted repository instead of the default.
export class TenantedDatabaseNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.database'
  override readonly dependencies = ['notification', 'database']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    const repo = app.make(TenantedNotificationRepository)
    manager.extend('database', ({ instanceName }) =>
      new DatabaseNotificationDriver({ name: instanceName, repository: repo }),
    )
  }
}
```

Then every dispatch through the database channel runs under `TenantManager.withTenant(...)` and writes the current tenant_id automatically. The unread query honours the same RLS policy, so callers see only their tenant's notifications.

This pattern mirrors `@strav/social/tenanted` — the framework provides the schema + repository + migration helper; the app provides the provider that wires them.

## Dual-channel — broadcast for live, database for persistence

The standard "you have a new notification" UX uses both channels:

```ts
class CommentReplyNotification extends BaseNotification {
  override via(): readonly string[] {
    return ['database', 'broadcast']
  }
  toDatabase(_n: Notifiable): Record<string, unknown> {
    return { commentId: this.payload.commentId, snippet: this.payload.text.slice(0, 80) }
  }
  toBroadcast(notifiable: Notifiable) {
    return {
      channel: `private-user.${notifiable.id}.notifications`,
      event: 'notification.created',
      data: { commentId: this.payload.commentId },
    }
  }
}
```

- **Database channel** — the row persists, the badge counts it on next page load.
- **Broadcast channel** — connected SSE clients receive the event immediately and update the UI without reloading.

Both channels share the dispatch ULID, so the client-side handler dedups against the eventually-arriving polled row:

```ts
es.addEventListener('notification.created', (e) => {
  const { commentId } = JSON.parse(e.data)
  const dispatchId = e.lastEventId           // matches NotificationRecord.id
  inbox.insertOptimistic({ id: dispatchId, commentId })
})

// Periodic poll for the actual row count (catches anything the SSE
// connection missed during a disconnect).
setInterval(async () => {
  const { count } = await fetch('/inbox/badge').then(r => r.json())
  inbox.reconcileBadge(count)
}, 30_000)
```

The optimistic insert from the SSE handler matches the eventual database row by id, so reconciliation is a no-op when everything works and a recover-from-missed-event when SSE was disconnected during dispatch.

## Cleaning up

Notifications accumulate. The framework doesn't ship a TTL — different apps want different retention. Two patterns:

**Time-based cleanup** — drop anything older than N days:

```sql
DELETE FROM notification
WHERE created_at < now() - interval '90 days';
```

Run nightly via the scheduler. Keep the window long enough that users who check infrequently still see their history; shorter if you have GDPR / data-minimisation constraints.

**Read-based cleanup** — drop read notifications after a shorter window:

```sql
DELETE FROM notification
WHERE read_at IS NOT NULL AND read_at < now() - interval '30 days';
```

This keeps unread notifications around indefinitely (the inbox never loses items the user hasn't seen), while limiting how long history-of-read-stuff lingers.

Vacuum the table afterwards if you're deleting a lot at once — Postgres' autovacuum keeps up under normal load but a one-off bulk delete is worth a manual VACUUM.
