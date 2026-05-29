/**
 * `Tool` — the framework-native shape every tool implementation
 * conforms to. Providers translate the `name`, `description`, and
 * `inputSchema` into their vendor's tool-definition wire format;
 * `execute` runs in-process on the framework side when the model
 * calls the tool.
 *
 * `inputSchema` is plain JSON Schema (draft 2020-12 compatible).
 * Apps that prefer Zod use the SDK's helpers and feed the resulting
 * JSON Schema into `defineTool`; the framework deliberately doesn't
 * couple to Zod so apps stay free to bring whatever schema library
 * they want.
 *
 * Generics: `TInput` is what `execute` receives (after the model's
 * raw input has been narrowed by validation at the call site, when
 * apps choose to validate). `TOutput` is what the agentic loop
 * appends as the `tool_result.content`. Both default to `unknown`
 * for apps that don't want the cognitive overhead of typing tools.
 */

export interface ToolContext {
  /** Provider-assigned call id — matches `ToolUseBlock.id`. */
  readonly callId: string
  /** Per-run free-form context bag passed by the caller. Optional. */
  readonly context: Readonly<Record<string, unknown>>
  /**
   * Cancellation signal forwarded from the run's `options.signal`.
   * Tools that wrap network calls (HTTP fetches, MCP servers, child
   * processes) should pass this through so cancellation actually
   * unwinds in-flight work.
   */
  readonly signal?: AbortSignal
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  /** JSON Schema for the tool's input. Providers translate this into their wire format. */
  inputSchema: Record<string, unknown>
  /** In-process executor. Throws propagate as `ToolExecutionError` through the runner. */
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}
