/**
 * `strav_jobs` schema — the backing table for `DatabaseQueue`.
 *
 * Naming convention: framework-managed tables that apps register +
 * migrate use the `strav_*` prefix (no leading underscore — those are
 * reserved for raw-DDL tables created by the runner / DDL emitter:
 * `_strav_migrations`, `_strav_tenant_sequences`). Apps register
 * `jobSchema` with their SchemaRegistry and `generateMigration` picks
 * it up like any other schema.
 *
 * Columns:
 *   - `id` (char(26), ULID PK) — globally unique across queues.
 *   - `queue` (varchar(64)) — named queue. Default `'default'`. Workers
 *     poll one queue at a time, so this is the routing key.
 *   - `job_name` (varchar(128)) — `JobRegistry` lookup key. The Worker
 *     deserializes the row by mapping this back to a `JobClass`.
 *   - `payload` (jsonb) — the `JSON.stringify`'d job payload.
 *   - `attempts` (integer, default 0) — count of attempts so far. The
 *     Worker increments before running `handle()`.
 *   - `max_attempts` (integer, default 3) — total retries allowed.
 *     `attempts >= max_attempts` after a failed attempt → terminal
 *     failure, moves to `failed_jobs` (V1 just leaves it; failed-jobs
 *     handling is its own slice).
 *   - `available_at` (timestamptz) — the earliest time a Worker may
 *     pick this row up. `now()` for immediate dispatch; `dispatchLater`
 *     pushes this into the future.
 *   - `reserved_at` (timestamptz, nullable) — when a Worker locked
 *     the row via `SELECT FOR UPDATE SKIP LOCKED`. NULL means
 *     unreserved.
 *   - `created_at` / `updated_at` — provided by `t.timestamps()`.
 *
 * Not `tenanted: true` — the queue is system-level. Multi-tenant apps
 * that want per-tenant queues can clone this schema with a tenant_id
 * FK + RLS, but that's a follow-up.
 */

import { Archetype, defineSchema } from '@strav/database'

export const jobSchema = defineSchema('strav_jobs', Archetype.Entity, (t) => {
  t.id()
  t.string('queue').max(64).default('default')
  t.string('job_name').max(128)
  t.json<unknown>('payload')
  t.integer('attempts').default(0)
  t.integer('max_attempts').default(3)
  t.timestamp('available_at')
  t.timestamp('reserved_at').nullable()
  t.timestamps()
})
