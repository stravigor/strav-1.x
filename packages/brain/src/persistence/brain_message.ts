/**
 * `BrainMessage` — the typed row of `brain_message`. One per turn.
 *
 * `content` mirrors `Message.content` — string for plain text or
 * `ContentBlock[]` when the turn carries structured blocks
 * (tool_use, tool_result, image, compaction, ...). JSONB hydration
 * is automatic.
 *
 * Assistant turns carry `model` / `usage` / `stop_reason` /
 * `response_id`; user turns leave them NULL. The repository's
 * `appendTurn` helper writes the right shape per role.
 */

import { Model } from '@strav/database'
import type { ChatUsage, ContentBlock } from '../types.ts'
import { brainMessageSchema } from './schemas/brain_message_schema.ts'

export type BrainMessageRole = 'user' | 'assistant'

export class BrainMessage extends Model {
  static override readonly schema = brainMessageSchema

  id!: string
  tenant_id!: string
  thread_id!: string
  turn_index!: number
  role!: BrainMessageRole
  content!: string | ContentBlock[]
  model!: string | null
  usage!: ChatUsage | null
  stop_reason!: string | null
  response_id!: string | null
  created_at!: Date
}
