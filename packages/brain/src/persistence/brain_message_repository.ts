/**
 * `BrainMessageRepository` — data-access object for `BrainMessage`.
 *
 * Append-only by design: messages get inserted and never updated.
 * `appendTurn` handles the next-`turn_index` lookup + INSERT in a
 * single round-trip via `INSERT ... SELECT COALESCE(MAX, -1) + 1`
 * so concurrent appends on the same thread don't race.
 *
 * Reads:
 *   - `loadForThread(threadId, opts?)` — paginated history,
 *     ordered by `turn_index ASC`.
 *   - `countForThread(threadId)` — total turn count, useful for
 *     pagination UIs.
 */

import { quoteIdent, Repository, type RepositoryScope } from '@strav/database'
import { ulid } from '@strav/kernel'
import type { ChatUsage, ContentBlock } from '../types.ts'
import { BrainMessage, type BrainMessageRole } from './brain_message.ts'
import { brainMessageSchema } from './schemas/brain_message_schema.ts'

export interface AppendTurnInput {
  threadId: string
  role: BrainMessageRole
  content: string | ContentBlock[]
  model?: string
  usage?: ChatUsage
  stopReason?: string
  responseId?: string
}

export interface LoadMessagesOptions {
  /** Pagination — defaults to no limit (full history). */
  limit?: number
  offset?: number
}

export class BrainMessageRepository extends Repository<BrainMessage> {
  static override readonly schema = brainMessageSchema
  static override readonly model = BrainMessage

  /**
   * Insert a new turn at the next `turn_index` for the thread. The
   * `turn_index` is computed in-SQL so two concurrent appends
   * don't collide — the unique `(thread_id, turn_index)` index on
   * the table catches any race that slips through.
   *
   * Lifecycle: routes through `create()` so `brain_message.created`
   * events fire. The `turn_index` is filled in by the SELECT side
   * of an explicit INSERT here rather than `create()` because the
   * value isn't known client-side.
   */
  async appendTurn(input: AppendTurnInput, opts?: RepositoryScope): Promise<BrainMessage> {
    const table = quoteIdent(brainMessageSchema.name)
    const sql = `
      INSERT INTO ${table}
        ("id", "thread_id", "turn_index", "role", "content",
         "model", "usage", "stop_reason", "response_id", "created_at")
      SELECT
        $1, $2,
        COALESCE((SELECT MAX("turn_index") FROM ${table} WHERE "thread_id" = $2), -1) + 1,
        $3, $4::jsonb, $5, $6::jsonb, $7, $8, NOW()
      RETURNING *
    `
    const params = [
      ulid(),
      input.threadId,
      input.role,
      JSON.stringify(input.content),
      input.model ?? null,
      input.usage !== undefined ? JSON.stringify(input.usage) : null,
      input.stopReason ?? null,
      input.responseId ?? null,
    ]
    const rows = await this.executor(opts).query<Record<string, unknown>>(sql, params)
    if (rows.length === 0) {
      throw new Error('BrainMessageRepository.appendTurn: INSERT returned no rows.')
    }
    return this.hydrate(rows[0]!)
  }

  /** Load every turn for a thread, ordered by `turn_index ASC`. */
  async loadForThread(
    threadId: string,
    opts: LoadMessagesOptions = {},
  ): Promise<BrainMessage[]> {
    let q = this.query().where('thread_id', threadId).orderBy('turn_index', 'asc')
    if (opts.limit !== undefined) q = q.limit(opts.limit)
    if (opts.offset !== undefined) q = q.offset(opts.offset)
    return q.get()
  }

  /** Total turn count for a thread — useful for pagination UIs. */
  async countForThread(threadId: string): Promise<number> {
    return this.count({ thread_id: threadId } as Partial<BrainMessage>)
  }
}

