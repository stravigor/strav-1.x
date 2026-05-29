/**
 * `AgentGenerateResult<T>` — what an Agent run returns when the
 * runner was switched into structured-output mode via
 * `.output(schema)`.
 *
 * Combines the structured-output payload (`value` + raw `text`) with
 * the agent-loop bookkeeping (`messages`, `iterations`, `stopReason`,
 * `usage`) so apps can still render the trace + report token spend
 * the same way they do for `AgentResult`. `iterations` is always `0`
 * in V1 because the structured-output path doesn't engage the
 * tool-use loop — see the docs for the (deferred) "tools + schema"
 * combined slice.
 */

import type { ChatUsage, Message } from './types.ts'

export interface AgentGenerateResult<T = unknown> {
  /** Parsed structured value matching the supplied `OutputSchema<T>`. */
  value: T
  /** Raw JSON text the model produced — handy for logging when `parse` rejects. */
  text: string
  /** Full message history of the run (single user → assistant turn in V1). */
  messages: Message[]
  /** Always `0` in V1 — the schema path doesn't engage the tool-use loop. */
  iterations: number
  /** Provider-reported terminal stop reason. */
  stopReason: string
  /** Token usage from the single underlying `generate` call. */
  usage: ChatUsage
}
