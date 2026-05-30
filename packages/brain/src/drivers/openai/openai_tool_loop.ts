/**
 * Shared non-streaming tool-loop iteration for OpenAI.
 *
 * The 4 OpenAI agentic loops (`_runLoop`, `_runLoopWithSchema`,
 * `_streamLoop`, `_streamLoopWithSchema`) all run the same outer
 * sequence: build params → call SDK → push assistant turn → check
 * terminal → dispatch tool calls → push tool results → increment
 * iteration. This module extracts the non-streaming half so
 * `_runLoop` and `_runLoopWithSchema` become thin orchestrators
 * that handle only their own terminal return shape
 * (`AgentResult | SuspendedRun` vs `AgentGenerateResult<T>`).
 *
 * Streaming variants are not unified here yet — yielding events
 * mid-iteration requires an async-generator wrapper that's a bigger
 * structural change.
 */

import type OpenAI from 'openai'
import type { RunWithToolsOptions } from '../../brain_driver.ts'
import { BrainError } from '../../brain_error.ts'
import type { Tool } from '../../tool.ts'
import type {
  ChatUsage,
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types.ts'
import { checkAborted, reqOpts } from './openai_helpers.ts'
import { addOpenAIUsage, fromOpenAIAssistantMessage } from './openai_response_mapper.ts'
import { executeToolCall, parseToolCallArgs } from './openai_tool_dispatch.ts'

/** Per-iteration mutable state. The helper mutates this in place. */
export interface NonStreamLoopState {
  workingMessages: Message[]
  aggregated: ChatUsage
  iterations: number
}

export function createNonStreamLoopState(messages: readonly Message[]): NonStreamLoopState {
  return {
    workingMessages: [...messages],
    aggregated: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    iterations: 0,
  }
}

/**
 * Per-iteration outcome the orchestrator branches on. `stop` and
 * `max_iterations` both terminate; the caller maps them to its own
 * return type (e.g. setting `stopReason: 'max_iterations'`).
 */
export type NonStreamIterationOutcome =
  | { kind: 'continue' }
  | { kind: 'stop'; assistantText: string; stopReason: string }
  | { kind: 'max_iterations'; assistantText: string }
  | { kind: 'suspended'; pendingToolCalls: ToolUseBlock[] }

export interface NonStreamIterationArgs {
  state: NonStreamLoopState
  toolMap: Map<string, Tool>
  maxIterations: number
  client: OpenAI
  /**
   * Built per iteration because `workingMessages` grows each round.
   * The schema variant's closure adds `response_format` after the
   * driver's base `buildParams` runs.
   */
  buildParams: (msgs: readonly Message[]) => OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  options: RunWithToolsOptions
  /**
   * Human-in-the-loop gate. Pass `options.shouldSuspend` to enable;
   * pass `undefined` to disable (schema callers don't support
   * suspension — the manager throws before reaching the loop).
   */
  suspendCheck: NonNullable<RunWithToolsOptions['shouldSuspend']> | undefined
}

/**
 * One round-trip of the OpenAI agentic loop. Returns a discriminated
 * outcome the orchestrator branches on; `state` is mutated in place
 * (workingMessages append, aggregated usage, iteration counter).
 */
export async function runOpenAINonStreamIteration(
  args: NonStreamIterationArgs,
): Promise<NonStreamIterationOutcome> {
  const { state, toolMap, maxIterations, client, buildParams, options, suspendCheck } = args
  checkAborted(options.signal)
  const params = buildParams(state.workingMessages)
  const response = await client.chat.completions.create(params, reqOpts(options))
  addOpenAIUsage(state.aggregated, response.usage)

  const choice = response.choices[0]
  if (!choice) {
    throw new BrainError('OpenAIBrainDriver: response had no choices.')
  }
  const assistantMessage = choice.message
  const assistantText = assistantMessage.content ?? ''

  // Append assistant turn so the next round-trip sends it back verbatim.
  state.workingMessages.push({
    role: 'assistant',
    content: fromOpenAIAssistantMessage(assistantMessage),
  })

  const toolCalls = assistantMessage.tool_calls ?? []
  if (toolCalls.length === 0 || choice.finish_reason !== 'tool_calls') {
    return { kind: 'stop', assistantText, stopReason: choice.finish_reason ?? 'stop' }
  }

  const resultBlocks: ContentBlock[] = []
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!
    if (call.type !== 'function') continue
    const { parsedInput, parseFailed } = parseToolCallArgs(
      call.function.name,
      call.id,
      call.function.arguments,
      options,
    )
    if (suspendCheck && !parseFailed) {
      const frameworkCall: ToolUseBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: (parsedInput ?? {}) as Record<string, unknown>,
      }
      if (await suspendCheck(frameworkCall, options.context)) {
        return {
          kind: 'suspended',
          pendingToolCalls: collectPendingToolCalls(toolCalls, i),
        }
      }
    }
    const { content, isError } = await executeToolCall(
      call.function.name,
      call.id,
      parsedInput,
      parseFailed,
      toolMap,
      options,
    )
    resultBlocks.push({
      type: 'tool_result',
      toolUseId: call.id,
      content,
      ...(isError ? { isError: true } : {}),
    } satisfies ToolResultBlock)
  }
  state.workingMessages.push({ role: 'user', content: resultBlocks })

  state.iterations++
  if (state.iterations >= maxIterations) {
    return { kind: 'max_iterations', assistantText }
  }
  return { kind: 'continue' }
}

/**
 * Collect the suspended-mid-batch pending calls. The suspend path
 * doesn't run `onToolError` for unparsable args — the human-in-the-
 * loop reviewer sees the raw string and decides what to do.
 */
function collectPendingToolCalls(
  toolCalls: readonly OpenAI.Chat.ChatCompletionMessageToolCall[],
  startIndex: number,
): ToolUseBlock[] {
  const pending: ToolUseBlock[] = []
  for (let j = startIndex; j < toolCalls.length; j++) {
    const c = toolCalls[j]!
    if (c.type !== 'function') continue
    let pInput: unknown = {}
    try {
      pInput = c.function.arguments ? JSON.parse(c.function.arguments) : {}
    } catch {
      pInput = c.function.arguments ?? {}
    }
    pending.push({
      type: 'tool_use',
      id: c.id,
      name: c.function.name,
      input: pInput as Record<string, unknown>,
    })
  }
  return pending
}
