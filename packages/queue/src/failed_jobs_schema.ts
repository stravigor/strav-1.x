/**
 * `strav_failed_jobs` schema — terminal failure dead-letter table.
 *
 * When `Worker.processOne()` exhausts a job's `max_attempts`, the row
 * moves from `strav_jobs` to `strav_failed_jobs` in a single
 * transaction — INSERT here, DELETE there. Apps inspect this table
 * to triage what blew up; the `queue:retry` / `queue:flush` console
 * commands (lands with `@strav/cli` in M4) operate on these rows.
 *
 * Columns:
 *   - `id` (char(26), ULID PK) — fresh per failure, not the original
 *     job id (the original is gone with the row).
 *   - `queue` (varchar(64)) — copied from `strav_jobs.queue`.
 *   - `job_name` (varchar(128)) — copied from `strav_jobs.job_name`.
 *   - `payload` (jsonb) — copied verbatim so retries can replay it.
 *   - `exception` (text) — the thrown error, serialized via
 *     `error.stack ?? String(error)`. Long; not indexed.
 *   - `attempts` (integer) — how many total attempts the job got
 *     before terminal failure.
 *   - `failed_at` (timestamptz) — wall-clock time of the move.
 *   - `created_at` / `updated_at` — provided by `t.timestamps()`.
 *
 * Not `tenanted: true` — same system-level scope as `strav_jobs`.
 */

import { Archetype, defineSchema } from '@strav/database'

export const failedJobsSchema = defineSchema('strav_failed_jobs', Archetype.Entity, (t) => {
  t.id()
  t.string('queue').max(64)
  t.string('job_name').max(128)
  t.json<unknown>('payload')
  t.text('exception')
  t.integer('attempts')
  t.timestamp('failed_at')
  t.timestamps()
})
