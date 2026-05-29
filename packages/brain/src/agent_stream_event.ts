/**
 * `AgentStreamEvent` — the union yielded by streaming agentic
 * runs (`Provider.streamWithTools` / `BrainManager.streamTools` /
 * `AgentRunner.stream`).
 *
 * Event vocabulary:
 *
 *   - `iteration_start` — fired before each model call. `iteration`
 *     starts at `0` and increments per round.
 *   - `text` — a text delta from the assistant turn currently in
 *     flight. Same shape as `StreamEvent.text` so apps can reuse
 *     UI code.
 *   - `tool_use` — the assistant turn finished and the framework
 *     parsed a tool call. Emitted with the parsed `input` before
 *     the framework runs the tool — apps that surface "calling
 *     X..." indicators flip them on here.
 *   - `tool_result` — the framework executed the tool and is about
 *     to feed the result back to the model. `isError` reflects
 *     whether the tool reported a failure (V1: only false today —
 *     thrown executions abort the loop with `ToolExecutionError`;
 *     graceful tool-error recovery is a later slice).
 *   - `iteration_end` — the assistant turn fully drained, including
 *     its `stopReason`. Apps that render per-iteration boundaries
 *     use this.
 *   - `stop` — terminal event. Carries the full `messages` trace,
 *     iteration count, aggregated usage, and the framework
 *     stop reason (`'end_turn'`, `'max_iterations'`, etc.). Equivalent
 *     to the non-streaming `AgentResult` minus the bare `text` —
 *     apps reconstruct that from `text` deltas or read the final
 *     message.
 *
 * What's NOT in V1:
 *   - Per-character tool-argument streaming. `tool_use` fires once
 *     the parsed input is ready. Streaming partial argument JSON
 *     is a follow-up — most apps don't need it and the SDKs handle
 *     it inconsistently.
 *   - `error` events. Failures throw out of the iterator (the
 *     consumer's `for await` rejects). Apps that want resilient
 *     loops catch around the consumer.
 */

import type { ChatUsage, Message } from './types.ts'

export type AgentStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      id: string
      name: string
      content: string
      isError: boolean
    }
  | { type: 'iteration_end'; iteration: number; stopReason: string | null }
  | {
      type: 'stop'
      stopReason: string
      iterations: number
      usage: ChatUsage
      messages: Message[]
    }
