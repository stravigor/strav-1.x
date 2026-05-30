/**
 * `brainThreadSchema` — one row per conversation.
 *
 * Carries the per-thread defaults that `Thread` already serializes
 * (`system`, `options`, `lastResponseId`) plus a few framework-side
 * fields apps want to filter / sort on:
 *
 *   - `id`            ULID primary key. Hand the same value back to
 *                     `BrainStore.loadThread(id)` to rehydrate.
 *   - `user_id`       App-defined owner. Stored as `text` (no FK) —
 *                     user table shape varies per app. Indexed in
 *                     the recommended migration so "list threads
 *                     for user X" stays fast.
 *   - `title`         Human label. Apps set it from the first user
 *                     turn or via an explicit "rename" UI.
 *   - `system`        Thread-owned system prompt. Mirrors
 *                     `ThreadState.system`. JSONB so the structured
 *                     form (text + cache flag) round-trips.
 *   - `options`       Thread defaults applied to every `send()`.
 *                     Mirrors `ThreadState.options`.
 *   - `last_response_id`  OpenAI Responses API stateful pointer.
 *                     Mirrors `ThreadState.lastResponseId`. NULL for
 *                     non-Responses providers.
 *   - `timestamps`    `created_at` + `updated_at` for sort / audit.
 *
 * Tenanted: `tenant_id` FK + RLS policies auto-injected by
 * `@strav/database`. Apps wrap calls in `tenants.withTenant(...)`
 * and the database enforces isolation — no app-level filter needed.
 *
 * The per-turn message history lives in `brain_message`, joined by
 * `thread_id`. This keeps every send to an O(1) INSERT and makes
 * pagination / per-turn analytics cheap.
 */

import { Archetype, defineSchema } from '@strav/database'

export const brainThreadSchema = defineSchema(
  'brain_thread',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('user_id').max(64).nullable()
    t.string('title').max(255).nullable()
    t.json('system').nullable()
    t.json('options').nullable()
    t.string('last_response_id').max(128).nullable()
    t.timestamps()
  },
  { tenanted: true },
)
