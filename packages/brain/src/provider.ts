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

import type { AgentResult } from './agent_result.ts'
import type { MCPServer } from './mcp_server.ts'
import type { OutputSchema } from './output_schema.ts'
import type { Tool } from './tool.ts'
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
}
