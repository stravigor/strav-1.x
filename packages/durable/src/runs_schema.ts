/**
 * `strav_workflow_runs` — the durable record of a single workflow
 * execution. One row per `runner.start()` call; mutated as the
 * `advance` handler walks the step list.
 *
 * Columns:
 *   - `id`             — ULID PK
 *   - `workflow_name`  — registry key the run was started against
 *   - `input`          — the original input object (jsonb, never mutated post-start)
 *   - `status`         — `pending` / `running` / `compensating` / `completed` / `failed`
 *   - `state`          — jsonb bag carrying `results` (the per-step return values)
 *   - `current_step`   — 0-based cursor pointing at the next step to advance
 *   - `result`         — set to `state.results` on completion; null otherwise
 *   - `error`          — terminal failure message; null on success
 *   - timestamps
 *
 * The hot path (advance / compensate) writes via raw SQL for atomicity;
 * application code that polls a run reads via the standard Repository
 * surface or via `DurableRunner.find`.
 */

import { Archetype, defineSchema } from '@strav/database'

export const workflowRunsSchema = defineSchema(
  'strav_workflow_runs',
  Archetype.Event,
  (t) => {
    t.id()
    t.string('workflow_name').max(255)
    t.json('input')
    t.string('status').max(32).default('pending')
    t.json('state')
    t.integer('current_step').default(0)
    t.json('result').nullable()
    t.text('error').nullable()
    t.timestamps()
  },
)
