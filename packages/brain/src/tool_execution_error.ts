/**
 * `ToolExecutionError` — wrapper thrown by the agentic loop when a
 * tool's `execute` function throws. Carries the tool name + the
 * provider's call id on `context` so apps building error reporters /
 * traces can correlate failures with model output without parsing
 * stack frames.
 *
 * V1 propagates these out of `runWithTools` — the loop aborts on the
 * first tool failure. A later slice may add a graceful path
 * (`{ type: 'tool_result', isError: true }` is appended and the
 * loop continues) but apps that need that today can catch the
 * error, append the result themselves, and re-call the runner.
 */

import { StravError } from '@strav/kernel'

export class ToolExecutionError extends StravError {
  constructor(toolName: string, callId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(
      `Tool "${toolName}" execution failed: ${message}`,
      { code: 'brain.tool-execution-failed', status: 500 },
      { context: { tool: toolName, callId }, cause },
    )
  }
}
