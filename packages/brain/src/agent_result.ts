/**
 * `AgentResult` — what an agentic loop returns when it ends. Combines
 * the final assistant `text`, the full message history (including
 * tool calls + results so apps can render the trace), the total
 * iteration count (how many tool-use round-trips the loop made),
 * and aggregated token usage across every model call inside the
 * loop.
 *
 * `stopReason` is the provider's terminal stop reason (typically
 * `'end_turn'`). When the loop exits because it hit `maxIterations`,
 * `stopReason` is `'max_iterations'` — distinct from the provider
 * value so apps can detect "the model would have kept going."
 */

import type { ChatUsage, Message } from './types.ts'

export interface AgentResult {
  /** Concatenated text from the final assistant turn. */
  text: string
  /** Full message history of the loop, including tool_use / tool_result blocks. */
  messages: Message[]
  /** Number of tool-use rounds. `0` when the model answered without tools. */
  iterations: number
  /**
   * Terminal stop reason. Either the provider's stop_reason (typically
   * `'end_turn'`) or the framework-specific `'max_iterations'` when
   * the loop hit its iteration ceiling.
   */
  stopReason: string
  /** Token usage summed across every model call in the loop. */
  usage: ChatUsage
}
