/**
 * Shared tool-dispatch helpers for the OpenAI loops
 * (`_runLoop`, `_runLoopWithSchema`, `_streamLoop`,
 * `_streamLoopWithSchema`).
 *
 * The 4 loops each iterate an agentic round-trip with subtly different
 * control flow — suspend-aware vs not, streaming vs not, schema vs not
 * — but the inner "parse JSON args, recover, run with recovery" and
 * the "materialize assistant turn from streamed chunks" sequences are
 * identical. They live here so each loop is the orchestrator, not the
 * implementer.
 */

import type { RunWithToolsOptions } from '../../brain_driver.ts'
import type { Tool } from '../../tool.ts'
import { ToolExecutionError } from '../../tool_execution_error.ts'
import { recoverOrThrow, runToolWithRecovery } from '../../tool_runner.ts'
import type { ContentBlock, TextBlock, ToolUseBlock } from '../../types.ts'

/** Outcome of `parseToolCallArgs`. `parseFailed` is set if JSON.parse threw and the error recovered. */
export interface ParsedToolCall {
  parsedInput: unknown
  parseFailed: { content: string; isError: boolean } | undefined
}

/**
 * Parse a tool call's JSON-encoded arguments. On parse failure, runs
 * `onToolError` recovery — when it returns a string, that becomes the
 * `tool_result` content; when it returns undefined, the inner
 * `recoverOrThrow` rethrows and the loop aborts. Callers either short-
 * circuit on `parseFailed` (skipping the actual tool call) or proceed
 * with `parsedInput`.
 */
export function parseToolCallArgs(
  callName: string,
  callId: string,
  callArgs: string,
  options: RunWithToolsOptions,
): ParsedToolCall {
  try {
    const parsedInput = callArgs ? JSON.parse(callArgs) : {}
    return { parsedInput, parseFailed: undefined }
  } catch (err) {
    const parseFailed = recoverOrThrow(
      new ToolExecutionError(
        callName,
        callId,
        new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
      ),
      options,
    )
    return { parsedInput: callArgs, parseFailed }
  }
}

/**
 * Execute one parsed tool call. If `parseFailed` is present (from
 * `parseToolCallArgs`), short-circuits with the recovered error content.
 * Otherwise dispatches via `runToolWithRecovery`.
 */
export async function executeToolCall(
  callName: string,
  callId: string,
  parsedInput: unknown,
  parseFailed: ParsedToolCall['parseFailed'],
  toolMap: Map<string, Tool>,
  options: RunWithToolsOptions,
): Promise<{ content: string; isError: boolean }> {
  if (parseFailed) return parseFailed
  return runToolWithRecovery(
    toolMap.get(callName),
    callName,
    callId,
    parsedInput,
    options,
  )
}

/** One streamed-chunk entry, accumulated across deltas by index. */
export interface StreamedCallEntry {
  id?: string
  name?: string
  args: string
  started: boolean
}

/** Sort the chunked tool_calls map by index and drop the bookkeeping. */
export function orderStreamedCalls(
  toolCallsByIndex: Map<number, StreamedCallEntry>,
): StreamedCallEntry[] {
  return [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v)
}

/**
 * Build the assistant-turn content from a streaming round-trip's
 * accumulated text + ordered tool calls. Mirrors what
 * `fromOpenAIAssistantMessage` does for non-streaming responses.
 *
 * Collapses to a bare string when there's only text — keeps the
 * `messages` array on simple turns clean.
 */
export function assistantTurnFromStream(
  textBuf: string,
  orderedCalls: readonly StreamedCallEntry[],
): string | ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (textBuf.length > 0) blocks.push({ type: 'text', text: textBuf } satisfies TextBlock)
  for (const call of orderedCalls) {
    if (!call.id || !call.name) continue
    let parsedInput: unknown = {}
    try {
      parsedInput = call.args ? JSON.parse(call.args) : {}
    } catch {
      parsedInput = call.args
    }
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: parsedInput,
    } satisfies ToolUseBlock)
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text
  return blocks
}
