/**
 * `brainMessageSchema` — one row per assistant or user turn within
 * a thread. Append-only; rows are inserted in `turn_index` order
 * and never updated (compaction blocks live as a regular assistant
 * row whose `content` includes a `CompactionBlock`).
 *
 * Why per-turn rather than a JSONB blob on `brain_thread`:
 *
 *   - **Pagination.** UIs render the latest N turns; queries select
 *     by `(thread_id, turn_index)` instead of parsing a JSON array.
 *   - **Per-turn metadata.** `model` / `usage` / `stop_reason` /
 *     `response_id` are indexed and queryable for cost analytics,
 *     audit, and routing (e.g., "which threads used gpt-5?").
 *   - **Append cost.** Each `send()` is a single INSERT, not a
 *     rewrite of the entire array.
 *
 * Columns:
 *
 *   - `id`           ULID primary key.
 *   - `thread_id`    FK → `brain_thread`. `onDelete: cascade` —
 *                    deleting a thread drops its history.
 *   - `turn_index`   0-based ordinal. Unique with `thread_id` (app
 *                    migration adds the index).
 *   - `role`         `user` or `assistant`. The framework's
 *                    `Message.role` union; tool_result blocks land
 *                    on user turns per the assistant ↔ user
 *                    handshake, so `role` reflects that.
 *   - `content`      JSONB — `string | ContentBlock[]`. Carries
 *                    every typed block: text, image, document,
 *                    audio, tool_use, tool_result, mcp_*, compaction.
 *   - `model`        Model identifier used for assistant turns
 *                    (NULL for user turns).
 *   - `usage`        JSONB — `ChatUsage` for assistant turns.
 *   - `stop_reason`  Provider terminal reason (`end_turn`, etc.).
 *   - `response_id`  OpenAI Responses API id when surfaced. Indexed
 *                    via partial index in the recommended migration.
 *   - `created_at`   Timestamp.
 *
 * Archetype.Event — append-only semantics; no `updated_at`.
 */

import { Archetype, defineSchema } from '@strav/database'
import { brainThreadSchema } from './brain_thread_schema.ts'

export const brainMessageSchema = defineSchema(
  'brain_message',
  Archetype.Event,
  (t) => {
    t.id()
    t.reference('thread_id').to(brainThreadSchema).onDelete('cascade').notNull()
    t.integer('turn_index').notNull()
    t.enum('role', ['user', 'assistant']).notNull()
    t.json('content').notNull()
    t.string('model').max(128).nullable()
    t.json('usage').nullable()
    t.string('stop_reason').max(64).nullable()
    t.string('response_id').max(128).nullable()
    t.timestamp('created_at').notNull()
  },
  { tenanted: true },
)
