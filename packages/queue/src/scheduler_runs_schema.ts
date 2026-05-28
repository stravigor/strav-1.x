/**
 * `strav_scheduler_runs` schema — tracks the last tick boundary at
 * which a `Scheduler.onOneServer` entry dispatched.
 *
 * Why the table exists: `pg_advisory_xact_lock` releases on COMMIT —
 * the lock is held only for the duration of the dispatch transaction
 * (~10ms). Without a run-tracking row, two servers entering the lock
 * block back-to-back at the start of the same minute would each see
 * "cron matches now" and dispatch — double work.
 *
 * The check inside the lock block:
 *   1. SELECT last_run_at WHERE name = $name.
 *   2. If last_run_at >= tick_boundary, another server already won
 *      this minute. Skip.
 *   3. Otherwise dispatch + UPSERT last_run_at = tick_boundary.
 *
 * The advisory lock serializes the read+write so the check is honest.
 *
 * Schema constraints: framework PK kinds are `id`/`uuid`/`bigSerial`/
 * `tenantedBigSerial`. None are text, so we can't make `name` itself
 * the PK; instead ULID PK + `name` UNIQUE. The ULID is dead weight on
 * the application side but keeps the row shape consistent with the
 * rest of the framework.
 */

import { Archetype, defineSchema } from '@strav/database'

export const schedulerRunsSchema = defineSchema('strav_scheduler_runs', Archetype.Entity, (t) => {
  t.id()
  t.string('name').max(128).unique()
  t.timestamp('last_run_at')
  t.timestamps()
})
