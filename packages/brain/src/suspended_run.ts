/**
 * `SuspendedRun` — what `runWithTools` (and `runner.run()`) returns
 * when the agentic loop pauses because `shouldSuspend(call)` returned
 * `true` for a tool the model wants to call.
 *
 * Use case: human-in-the-loop gating. The integrator inspects
 * `pendingToolCalls`, obtains results out-of-band (human approval,
 * external worker, queued job, ...), and calls
 * `brain.resumeTools(state, results, ...)` or
 * `runner.resume(state, results)` to continue the conversation.
 *
 * State model:
 *   - `state.messages` contains every message exchanged up to and
 *     including the assistant turn that requested the pending tool
 *     calls. Resume picks up by appending tool_result blocks for
 *     each pending call and re-entering the loop — no special
 *     provider-level resume hook is needed.
 *   - `state` is plain JSON — apps persist it across process
 *     boundaries (e.g., one row per pending agent run in Postgres).
 *
 * Mid-batch invariant: when a tool call in a multi-call batch
 * triggers suspension, ALL remaining calls in that same batch are
 * captured together in `pendingToolCalls`. Apps MUST supply results
 * for every entry on resume; otherwise the provider's
 * tool_use / tool_result pairing becomes unbalanced and the next
 * model call rejects.
 */

import { BrainError } from './brain_error.ts'
import type {
  ChatUsage,
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from './types.ts'

export interface SuspendedRun {
  status: 'suspended'
  /**
   * The model's pending tool calls — the one that triggered the
   * suspension, plus any unexecuted siblings from the same
   * assistant turn. Match by `id` when supplying results.
   */
  pendingToolCalls: ToolUseBlock[]
  /** JSON-serializable snapshot of the loop state at the suspension point. */
  state: SuspendedState
}

export interface SuspendedState {
  /** Full message history up to and including the suspending assistant turn. */
  messages: Message[]
  /** Iteration count at the suspension point — preserved across resume. */
  iterations: number
  /** Aggregated token usage across the iterations completed so far. */
  usage: ChatUsage
  /**
   * Provider response id captured at the suspension point. When the
   * provider supports stateful conversations (OpenAI Responses API),
   * resume threads this back through `previousResponseId` so the
   * model picks up exactly where it paused.
   */
  responseId?: string
}

/**
 * Result of one pending tool call, supplied to `resumeTools`. The
 * shape mirrors `ToolResultBlock` minus the `type` discriminator —
 * the framework builds the block at resume time.
 *
 * To signal a failure (so the model adapts rather than crashing the
 * loop), pass a string describing the error as `content` and set
 * `isError: true`.
 */
export interface ToolResultInput {
  toolUseId: string
  content: string
  isError?: boolean
}

/**
 * Type guard. Convenient at call sites that need to discriminate
 * between a completed `AgentResult` and a `SuspendedRun`.
 *
 * ```ts
 * const out = await brain.runTools(prompt, tools, { shouldSuspend })
 * if (isSuspended(out)) {
 *   await persistForLater(out.pendingToolCalls, out.state)
 *   return
 * }
 * render(out.text)
 * ```
 */
export function isSuspended(value: unknown): value is SuspendedRun {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'suspended'
  )
}

/**
 * Append a `tool_result` user-role message to `state.messages` that
 * carries one block per supplied result. Validates that the pending
 * tool_use ids referenced in the latest assistant turn are all
 * covered — missing results throw `BrainError` so the next provider
 * call doesn't fail with an opaque "tool_use without tool_result"
 * upstream error.
 *
 * Exported for `BrainManager.resumeTools` / `AgentRunner.resume`;
 * tests can use it directly to verify resume mechanics without
 * round-tripping through a provider.
 */
export function appendResumeResults(
  state: SuspendedState,
  results: readonly ToolResultInput[],
): Message[] {
  const pending = collectPendingIds(state.messages)
  for (const id of pending) {
    if (!results.some((r) => r.toolUseId === id)) {
      throw new BrainError(
        `resumeTools: missing result for pending tool call id "${id}". Every pending tool_use in the suspending assistant turn must be answered on resume.`,
        { context: { pendingIds: [...pending], suppliedIds: results.map((r) => r.toolUseId) } },
      )
    }
  }
  const resultBlocks: ContentBlock[] = results.map((r) => {
    const block: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: r.toolUseId,
      content: r.content,
      ...(r.isError ? { isError: true } : {}),
    }
    return block
  })
  return [...state.messages, { role: 'user', content: resultBlocks }]
}

/**
 * Look at the latest assistant turn in `messages` and pull every
 * tool_use block's id. Used to validate resume coverage.
 */
function collectPendingIds(messages: readonly Message[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    if (typeof m.content === 'string') return []
    return m.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => b.id)
  }
  return []
}
