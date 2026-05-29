/**
 * `AgentStreamEvent<T>` — the union yielded by streaming agentic
 * runs (`Provider.streamWithTools` / `BrainManager.streamTools` /
 * `AgentRunner.stream`).
 *
 * The generic `T` carries the structured-output type when the run
 * was schema-constrained:
 *   - With the default `T = never`, the terminal `stop` event is the
 *     plain shape: `{ stopReason, iterations, usage, messages }`.
 *   - With `T` set (via `BrainManager.streamGenerateWithTools` or
 *     `AgentRunner.stream()` after `.output(schema)`), the `stop`
 *     event additionally carries `{ value: T; text: string }` — the
 *     parsed JSON shaped to the schema and the raw text the model
 *     produced.
 *
 * Event vocabulary:
 *
 *   - `iteration_start` — fired before each model call. `iteration`
 *     starts at `0` and increments per round.
 *   - `text` — a text delta from the assistant turn currently in
 *     flight. Same shape as `StreamEvent.text` so apps can reuse
 *     UI code.
 *   - `tool_use_start` — a tool call has begun streaming. Fires
 *     as soon as the model emits the call's `id` + `name`,
 *     before the arguments finish streaming. Apps that render
 *     "(calling X with …)" indicators show the tool name here.
 *     Anthropic + OpenAI emit this from streaming chunks; Gemini
 *     doesn't stream tool arguments (parts arrive complete) and
 *     skips both `tool_use_start` and `tool_use_delta`.
 *   - `tool_use_delta` — a chunk of the tool-call's argument JSON.
 *     Apps that render the model composing the call (e.g. typing
 *     `search(q='current state of bun.sql ...`) accumulate
 *     `argsDelta` per `id` and re-render. The argument JSON is
 *     partial / possibly malformed mid-stream — only the final
 *     `tool_use` event carries the parsed input.
 *   - `tool_use` — the assistant turn finished and the framework
 *     parsed a tool call. Emitted with the parsed `input` before
 *     the framework runs the tool. Source-of-truth for tool calls;
 *     cross-provider consumers can rely on this even when the
 *     start/delta events aren't fired.
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
 *     stop reason (`'end_turn'`, `'max_iterations'`, etc.). When the
 *     run was schema-constrained, also carries `value` (parsed JSON)
 *     and `text` (the raw JSON the model emitted).
 *
 * What's NOT in V1:
 *   - `error` events. Failures throw out of the iterator (the
 *     consumer's `for await` rejects). Apps that want resilient
 *     loops catch around the consumer.
 */

import type { ChatUsage, Message } from './types.ts'

interface BaseStopEvent {
  type: 'stop'
  stopReason: string
  iterations: number
  usage: ChatUsage
  messages: Message[]
}

interface ValueStopEvent<T> extends BaseStopEvent {
  /** Parsed JSON shaped to the supplied `OutputSchema<T>`. */
  value: T
  /** Raw JSON text the model emitted on its terminal turn. */
  text: string
}

/**
 * The `stop` variant narrows when the stream was schema-constrained
 * — the `[T] extends [never]` form is the standard "is this still
 * the default never?" check (a bare `T extends never` would
 * distribute over union types and break).
 */
type StopEvent<T> = [T] extends [never] ? BaseStopEvent : ValueStopEvent<T>

export type AgentStreamEvent<T = never> =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; argsDelta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      id: string
      name: string
      content: string
      isError: boolean
    }
  | { type: 'iteration_end'; iteration: number; stopReason: string | null }
  | StopEvent<T>
