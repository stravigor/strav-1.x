/**
 * `strav_workflow_journal` — per-step checkpoint log.
 *
 * One row per step *completion* (success or terminal failure). The
 * `UNIQUE (run_id, step_name)` constraint is the load-bearing
 * idempotency mechanism: when the queue redelivers an `advance` job
 * after a worker crash mid-step, the handler can re-INSERT under a
 * conflict and detect "we already completed this step" without
 * re-running the handler.
 *
 * Columns:
 *   - `id`           — ULID PK
 *   - `run_id`       — FK to `strav_workflow_runs`
 *   - `step_name`    — step identifier (workflow.steps[i].name)
 *   - `status`       — `completed` (handler returned) | `failed` (terminal)
 *   - `result`       — jsonb of the handler's return; null on failure
 *   - `error`        — terminal failure message; null on success
 *   - `attempts`     — total attempts the step took (1 = succeeded on first try)
 *   - `completed_at` — wall-clock timestamp the row was inserted
 *
 * In-flight retries are tracked on the *run* row (a `state.attempts`
 * counter per step name), not here — the journal is append-only and
 * carries only terminal step outcomes.
 */

import { Archetype, defineSchema } from '@strav/database'

export const workflowJournalSchema = defineSchema(
  'strav_workflow_journal',
  Archetype.Event,
  (t) => {
    t.id()
    t.string('run_id').max(26)
    t.string('step_name').max(255)
    t.string('status').max(32)
    t.json('result').nullable()
    t.text('error').nullable()
    t.integer('attempts').default(1)
    t.timestamp('completed_at')
    t.timestamps()
  },
)

/**
 * Index name for the `(run_id, step_name)` UNIQUE that DurableProvider
 * provisions at boot. The composite unique can't live in the schema
 * builder (no table-level unique in V1 — see `t.unique`); the
 * provider emits it via `CREATE UNIQUE INDEX IF NOT EXISTS` after
 * the journal table is created. Belt-and-suspenders against
 * accidental dup writes — the advance handler's row-lock on the run
 * already serializes journal INSERTs for a given (run_id, step_name).
 */
export const JOURNAL_UNIQUE_INDEX = 'strav_workflow_journal_run_step_unique_idx'
