/**
 * `runToolWithRecovery` — shared helper used by every provider's
 * agentic loop to execute one tool call.
 *
 * Encapsulates two error paths and the optional `onToolError`
 * recovery callback:
 *
 *   1. **Tool not registered** — the model called a name that
 *      isn't in `toolMap`. Without recovery, throw
 *      `ToolExecutionError`. With recovery, the callback's return
 *      string becomes the `tool_result.content` (with `isError:
 *      true`) and the loop continues — the model sees "unknown
 *      tool" and adapts.
 *
 *   2. **`execute()` throws** — the tool's body raised. Same
 *      pattern: either rethrow as `ToolExecutionError` or feed
 *      back as an error result.
 *
 * The returned shape is the framework-agnostic `{ content, isError }`
 * pair each provider then wraps into its own `tool_result` block
 * shape (Anthropic `tool_result` with `is_error`; OpenAI tool-role
 * message content; Gemini `functionResponse` with `{ error }`).
 */

import type { RunWithToolsOptions } from './brain_driver.ts'
import type { Tool, ToolContext } from './tool.ts'
import { ToolExecutionError } from './tool_execution_error.ts'

export interface ToolRunResult {
  content: string
  isError: boolean
}

export async function runToolWithRecovery(
  tool: Tool | undefined,
  toolName: string,
  callId: string,
  input: unknown,
  options: RunWithToolsOptions,
): Promise<ToolRunResult> {
  if (!tool) {
    return recoverOrThrow(
      new ToolExecutionError(
        toolName,
        callId,
        new Error(`Tool "${toolName}" is not registered.`),
      ),
      options,
    )
  }

  const ctx: ToolContext = {
    callId,
    context: options.context ?? {},
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }
  let output: unknown
  try {
    output = await tool.execute(input, ctx)
  } catch (cause) {
    return recoverOrThrow(new ToolExecutionError(toolName, callId, cause), options)
  }
  return {
    content: typeof output === 'string' ? output : JSON.stringify(output),
    isError: false,
  }
}

/**
 * Resolve a `ToolExecutionError` through the `onToolError` callback
 * (when set) or rethrow. Used by providers for failures that happen
 * outside `tool.execute` — e.g., OpenAI's JSON-parse-arguments path.
 */
export function recoverOrThrow(
  error: ToolExecutionError,
  options: RunWithToolsOptions,
): ToolRunResult {
  const recovered = options.onToolError?.(error)
  if (typeof recovered !== 'string') throw error
  return { content: recovered, isError: true }
}
