/**
 * `BrainThread` — the typed row of `brain_thread`. One per
 * conversation.
 *
 * The model's `system` / `options` / `last_response_id` columns
 * mirror `ThreadState` so apps that hydrate a thread can rebuild a
 * `Thread` instance via `BrainStore.loadThread(...)`.
 *
 * `user_id` is app-defined — the framework doesn't constrain user
 * shapes. Apps that want FK enforcement add it in a follow-up
 * migration (same pattern as `@strav/auth`'s `session.user_id`).
 */

import { Model } from '@strav/database'
import type { ChatOptions, SystemPrompt } from '../types.ts'
import { brainThreadSchema } from './schema/brain_thread_schema.ts'

export class BrainThread extends Model {
  static override readonly schema = brainThreadSchema

  id!: string
  tenant_id!: string
  user_id!: string | null
  title!: string | null
  system!: SystemPrompt | null
  options!: ChatOptions | null
  last_response_id!: string | null
  created_at!: Date
  updated_at!: Date
}
