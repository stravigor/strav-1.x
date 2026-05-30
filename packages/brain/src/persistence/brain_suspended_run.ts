/**
 * `BrainSuspendedRun` — the typed row of `brain_suspended_run`.
 *
 * `pending_tool_calls` and `state` round-trip the framework's
 * `SuspendedRun` shape verbatim — apps load this row, take the
 * model's `pending_tool_calls`, gather human approvals, and call
 * `brain.resumeTools(state, results, tools, options)` with the
 * `state` field unchanged.
 */

import { Model } from '@strav/database'
import type { SuspendedState } from '../suspended_run.ts'
import type { ToolUseBlock } from '../types.ts'
import { brainSuspendedRunSchema } from './schemas/brain_suspended_run_schema.ts'

export type BrainSuspendedRunStatus = 'pending' | 'resumed' | 'cancelled'

export class BrainSuspendedRun extends Model {
  static override readonly schema = brainSuspendedRunSchema

  id!: string
  tenant_id!: string
  thread_id!: string | null
  user_id!: string | null
  pending_tool_calls!: ToolUseBlock[]
  state!: SuspendedState
  status!: BrainSuspendedRunStatus
  created_at!: Date
  updated_at!: Date
}
