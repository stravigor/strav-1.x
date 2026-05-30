/**
 * `brainSuspendedRunSchema` — a paused agentic loop awaiting
 * human-in-the-loop tool approval.
 *
 * Two real use cases drive the shape:
 *
 *   1. **Linked to a thread** — the suspending run was part of a
 *      conversational thread; the app wants the suspended state to
 *      reference its thread so the UI can show "thread X is paused
 *      waiting on Y." `thread_id` is the FK, nullable so detached
 *      runs are fine.
 *   2. **Standalone** — the run came from a one-shot `runTools(...)`
 *      call (cron job, queued worker, ...). No thread context;
 *      `thread_id` stays NULL.
 *
 * Columns:
 *
 *   - `id`                  ULID primary key. The id apps reference
 *                           when resuming.
 *   - `thread_id`           FK → `brain_thread`, NULLABLE,
 *                           `onDelete: set null` — if the thread
 *                           gets deleted, the suspended run keeps
 *                           its data so the human approver can
 *                           still inspect it.
 *   - `user_id`             App-defined approver / owner.
 *   - `pending_tool_calls`  JSONB — `ToolUseBlock[]` the model
 *                           wants executed. Multi-call batches are
 *                           captured together (mid-batch invariant).
 *   - `state`               JSONB — `SuspendedState` snapshot. The
 *                           framework's `brain.resumeTools(state,
 *                           ...)` takes this as its first arg.
 *   - `status`              `pending | resumed | cancelled`. Apps
 *                           bulk-list pending runs and walk through
 *                           an approval queue.
 *   - `timestamps`          `created_at` for "how long pending?"
 *                           sorts, `updated_at` for transition
 *                           tracking.
 *
 * Tenanted: standard `tenant_id` + RLS.
 */

import { Archetype, defineSchema } from '@strav/database'
import { brainThreadSchema } from './brain_thread_schema.ts'

export const brainSuspendedRunSchema = defineSchema(
  'brain_suspended_run',
  Archetype.Entity,
  (t) => {
    t.id()
    t.foreign('thread_id').to(brainThreadSchema).onDelete('set null').nullable()
    t.string('user_id').max(64).nullable()
    t.json('pending_tool_calls').notNull()
    t.json('state').notNull()
    t.enum('status', ['pending', 'resumed', 'cancelled']).notNull().default('pending')
    t.timestamps()
  },
  { tenanted: true },
)
