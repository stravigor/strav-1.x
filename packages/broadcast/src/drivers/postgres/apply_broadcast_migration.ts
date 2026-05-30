/**
 * `applyBroadcastMigration` — emit DDL for the
 * `strav_broadcast_events` ledger plus the two indexes the
 * `PostgresBroadcaster` relies on:
 *
 *   - `id` PK (created by the `bigSerial` column) — the poller's cursor.
 *   - `created_at` index — used by the retention sweep.
 *
 * Apps register `broadcastEventSchema` with their `SchemaRegistry`
 * and call this helper from a migration's `up`:
 *
 *   await applyBroadcastMigration(db, { registry })
 *
 * Mirrors `applyNotificationMigration` from `@strav/notification/database`.
 */

import { type DatabaseExecutor, emitCreateTable, type SchemaRegistry } from '@strav/database'
import { broadcastEventSchema } from './broadcast_event_schema.ts'

export interface ApplyBroadcastMigrationOptions {
  registry: SchemaRegistry
}

export async function applyBroadcastMigration(
  db: DatabaseExecutor,
  options: ApplyBroadcastMigrationOptions,
): Promise<void> {
  const { registry } = options
  await db.execute(emitCreateTable(broadcastEventSchema, { registry }).sql)
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_strav_broadcast_events_created_at"
     ON "${broadcastEventSchema.name}" ("created_at")`,
  )
}
