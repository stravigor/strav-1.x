/**
 * `sessionSchema` — the Schema for the `session` table.
 *
 * Shape:
 *   - `id`         ULID primary key. Same value that lives in the session
 *                  cookie — handing the cookie value to the framework is
 *                  enough to look the session up.
 *   - `user_id`    Opaque user identifier (`Authenticatable.getAuthIdentifier()`).
 *                  Stored as `text` rather than a FK because the user
 *                  table shape varies per app (id/uuid/bigSerial; different
 *                  table name). Apps that want FK enforcement can add it
 *                  in a follow-up migration.
 *   - `expires_at` `timestamptz` — past values mean "expired, ignore."
 *                  The guard reads it on authenticate; a separate cleanup
 *                  command sweeps stale rows.
 *   - `timestamps` `created_at` + `updated_at` — useful for debugging /
 *                  audit. Not load-bearing.
 *
 * Not in V1 (each lands as its own slice):
 *   - `last_seen_at` — needed for sliding-window expiry
 *   - `ip_address` / `user_agent` — fingerprint / audit fields
 *   - `payload` jsonb — used by flash messages, CSRF, etc.
 *
 * Apps register this schema with their `SchemaRegistry` and ship a
 * migration (the README walks through using `emitCreateTable(sessionSchema)`).
 */

import { Archetype, defineSchema } from '@strav/database'

export const sessionSchema = defineSchema('session', Archetype.Entity, (t) => {
  t.id()
  t.string('user_id').max(64).notNull()
  t.timestamp('expires_at').notNull()
  t.timestamps()
})
