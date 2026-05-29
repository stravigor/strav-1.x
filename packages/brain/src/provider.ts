/**
 * `Provider` — the contract every brain backend implements.
 *
 * Each concrete provider (Anthropic, OpenAI later, Gemini later,
 * DeepSeek later) wraps the vendor's SDK and translates the framework
 * shapes (`Message`, `ChatOptions`) into the vendor's native request,
 * then translates the response back into `ChatResult` / `StreamEvent`.
 *
 * Providers are values, not classes — apps use them via the
 * `BrainManager` facade. The interface is exported so apps that need
 * to plug in a custom provider (e.g. a local Ollama) can do so without
 * subclassing.
 */

import type { AgentGenerateResult } from './agent_generate_result.ts'
import type { AgentResult } from './agent_result.ts'
import type { AgentStreamEvent } from './agent_stream_event.ts'
import type { MCPServer } from './mcp_server.ts'
import type { OutputSchema } from './output_schema.ts'
import type { Tool } from './tool.ts'
import type { ToolExecutionError } from './tool_execution_error.ts'
import type {
  ChatOptions,
  ChatResult,
  GenerateResult,
  Message,
  StreamEvent,
} from './types.ts'

export interface RunWithToolsOptions extends ChatOptions {
  /** Safety ceiling on tool-use round-trips. Default `10`. */
  maxIterations?: number
  /** Free-form context bag passed to every tool's `execute(input, ctx)`. */
  context?: Record<string, unknown>
  /**
   * MCP servers Anthropic should connect to on this call. Merges
   * with `config.brain.mcpServers` (per-call wins). Empty array or
   * undefined → no MCP servers. Anthropic's backend handles tool
   * discovery + invocation; the framework only surfaces the
   * resulting `mcp_tool_use` / `mcp_tool_result` blocks.
   */
  mcpServers?: readonly MCPServer[]
  /**
   * Tool-error recovery hook. Called when a tool's `execute` throws
   * — OR when the model called a tool that isn't registered. Two
   * outcomes:
   *
   *   - Return a string → the loop continues. The string lands as
   *     `tool_result.content` with `isError: true`, the model sees
   *     the error and can adapt (try a different approach, ask the
   *     user, give up). Recommended for production agents that
   *     should survive transient failures.
   *
   *   - Return `undefined` (the default when this option is unset)
   *     → the framework throws `ToolExecutionError` and the loop
   *     aborts. Same behavior as before this option existed.
   *
   * The hook may inspect `error.cause` to filter — e.g., feed back
   * transient HTTP errors but rethrow programmer errors:
   *
   * ```ts
   * onToolError: (err) =>
   *   err.cause instanceof TransientError ? err.cause.message : undefined
   * ```
   */
  onToolError?(error: ToolExecutionError): string | undefined
}

export interface Provider {
  /** Identifier — matches the `config.brain.providers` key. */
  readonly name: string

  /**
   * Generate a single reply. Awaits the full response; for
   * token-by-token rendering use `stream()`.
   */
  chat(messages: readonly Message[], options?: ChatOptions): Promise<ChatResult>

  /**
   * Stream the reply as it's generated. The async iterable yields
   * `text` events for each delta and a final `stop` event with usage
   * + stop-reason. Apps that want the full collected message at the
   * end pass the same `messages` to `chat()` instead; this surface is
   * for UI streaming, not for "make one call and get the message".
   */
  stream(messages: readonly Message[], options?: ChatOptions): AsyncIterable<StreamEvent>

  /**
   * Count input tokens for a given message set + options. Used by
   * apps that need to budget context before sending. Optional — not
   * every provider exposes a cheap token-count endpoint, so the
   * implementation may approximate.
   */
  countTokens?(messages: readonly Message[], options?: ChatOptions): Promise<number>

  /**
   * Agentic loop. Sends the `messages` + `tools` to the model;
   * detects tool-use blocks in the response; runs the matching
   * tool's `execute`; appends the result and re-asks. Loops until
   * the model returns `stop_reason: 'end_turn'` (or its
   * provider-specific equivalent) or `maxIterations` is hit.
   *
   * Optional on the interface so providers that don't (yet) support
   * tool use can omit it; `BrainManager.runTools` throws a
   * `BrainError` when the configured provider lacks the method.
   */
  runWithTools?(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): Promise<AgentResult>

  /**
   * Structured output. Sends `messages` to the model with a
   * JSON-Schema constraint and returns the parsed object. Apps that
   * supplied `schema.parse` get a runtime-validated value; otherwise
   * the value is `T` by type assertion (the provider does its own
   * upstream schema enforcement, but the framework doesn't validate).
   *
   * Optional on the interface so providers that lack a structured-
   * output endpoint can omit it; `BrainManager.generate` throws a
   * `BrainError` when the configured provider doesn't expose this.
   */
  generate?<T>(
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options?: ChatOptions,
  ): Promise<GenerateResult<T>>

  /**
   * Tool-loop + structured output combined. Runs the agentic loop
   * with the same tool-handling as `runWithTools`, but pins a
   * JSON-Schema constraint on every turn — so when the model
   * finally answers without calling a tool, its text is JSON
   * matching the schema. Returns the parsed value alongside the
   * loop bookkeeping.
   *
   * Optional on the interface; `BrainManager.generateWithTools`
   * throws `BrainError` when the configured provider lacks it.
   */
  runWithToolsAndSchema?<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>>

  /**
   * Streaming variant of `runWithToolsAndSchema`. Same agentic loop,
   * same schema constraint on every turn — yielded as
   * `AgentStreamEvent<T>`s. The terminal `stop` event carries the
   * parsed `value` + raw `text` alongside the loop bookkeeping.
   *
   * Optional; `BrainManager.streamGenerateWithTools` throws
   * `BrainError` when the chosen provider doesn't implement it.
   */
  streamWithToolsAndSchema?<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<T>>

  /**
   * Streaming variant of `runWithTools`. Yields `AgentStreamEvent`s
   * as the loop progresses — text deltas during model turns,
   * `tool_use` / `tool_result` boundaries around tool execution,
   * `iteration_start` / `iteration_end` per round, a terminal
   * `stop` with the full trace + usage.
   *
   * Optional — providers without a streaming tool-loop implementation
   * can omit it; `BrainManager.streamTools` throws `BrainError` in
   * that case.
   */
  streamWithTools?(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent>
}
