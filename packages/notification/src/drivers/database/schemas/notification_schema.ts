/**
 * `notificationSchema` — append-only ledger of dispatched
 * notifications. **Non-tenanted by default** (framework policy:
 * multitenancy is opt-in). Apps that need per-tenant scoping import
 * `tenantedNotificationSchema` from `@strav/notification/tenanted`
 * instead.
 *
 * One row per `(notifiable, notification, dispatch)` triple. The
 * `read_at` column lets apps render an "unread" badge by counting
 * rows where it's null.
 *
 * Columns:
 *
 *   - `id`               ULID PK — matches `NotificationContext.id`
 *                        so a notification's persisted row, log line,
 *                        and any downstream channel references all
 *                        share the same correlation id.
 *   - `notifiable_id`    Recipient's domain id (string). Apps store
 *                        ulids, uuids, ints — all fit as strings.
 *   - `notifiable_type`  Recipient class name (free-form). Apps
 *                        with one Notifiable model (e.g. `User`)
 *                        leave it constant; multi-Notifiable apps
 *                        use it to dispatch resolution.
 *   - `type`             Notification class name. Apps render by
 *                        type (`new_message`, `invoice_paid`, …).
 *   - `data`             jsonb payload from `toDatabase(notifiable)`.
 *   - `read_at`          When the recipient marked this read.
 *                        Null = unread.
 *   - `created_at`       Dispatch timestamp.
 *   - `updated_at`       Last touched (mark-as-read).
 */

import { Archetype, defineSchema } from '@strav/database'

export const notificationSchema = defineSchema('notification', Archetype.Entity, (t) => {
  t.id()
  t.string('notifiable_id').max(64).notNull()
  t.string('notifiable_type').max(128).notNull()
  t.string('type').max(128).notNull()
  t.json('data').notNull().default({})
  t.timestamp('read_at').nullable()
  t.timestamp('created_at').notNull()
  t.timestamp('updated_at').notNull()
})
