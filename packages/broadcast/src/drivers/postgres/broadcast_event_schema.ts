/**
 * `strav_broadcast_events` schema — the backing ledger for
 * `PostgresBroadcaster`.
 *
 * Append-only event log. Each `publish()` INSERTs one row; the
 * shared per-process poller runs `SELECT * FROM strav_broadcast_events
 * WHERE id > $lastId ORDER BY id` on a configurable interval and
 * fanouts new rows to in-process subscribers.
 *
 * Columns:
 *   - `id` (bigSerial PK) — monotonically increasing; the poller's
 *     cursor. Big enough that we never wrap.
 *   - `channel` (text) — routing key.
 *   - `event_name` (text) — the publisher-set verb tag.
 *   - `event_id` (text) — publisher-assigned identifier (ULIDs
 *     recommended). Receivers use this to dedup; we keep it as text
 *     rather than reusing `id` so a publish from one node carries an
 *     identifier other nodes can quote in their fan-out without
 *     coordinating SERIAL values.
 *   - `data` (jsonb) — JSON-serialised payload.
 *   - `created_at` (timestamptz, default now()) — used by the retention
 *     sweep to drop old events; not exposed to subscribers.
 *
 * `Archetype.Event` — matches the table's append-only semantics.
 * Non-tenanted by default (framework policy: multitenancy is opt-in).
 * Per-tenant pub/sub is achievable by namespacing channels with the
 * tenant ID (`tenant:42:orders.*`) — RLS on this table would force a
 * subscriber connection to know every tenant in advance, which
 * defeats the polling model.
 */

import { Archetype, defineSchema } from '@strav/database'

export const broadcastEventSchema = defineSchema('strav_broadcast_events', Archetype.Event, (t) => {
  t.bigSerial('id')
  t.text('channel')
  t.text('event_name')
  t.text('event_id')
  t.json<unknown>('data')
  t.timestamp('created_at')
})
