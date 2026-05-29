/**
 * `Agent` — declarative base class for AI agents.
 *
 * Apps subclass and set the static-ish properties: which model to
 * use, what the agent's persona is, which tools it has access to,
 * and an optional iteration ceiling. The `BrainManager.agent(Class)`
 * call resolves an instance via the container, builds an
 * `AgentRunner`, and lets the app stream input + context into it.
 *
 * ```ts
 * @inject()
 * class ResearchAgent extends Agent {
 *   override readonly instructions = 'You are a meticulous research assistant.'
 *   override readonly tools = [searchTool, summarizeTool]
 *   override readonly tier: ModelTier = 'powerful'
 * }
 *
 * const result = await brain.agent(ResearchAgent)
 *   .input('What is the current state of bun.sql?')
 *   .context({ userId: '01ABC...' })
 *   .run()
 * ```
 *
 * Structured output (typed result without `.output(schema)` at the call site):
 *
 * ```ts
 * class CityAgent extends Agent<CityAnswer> {
 *   override readonly instructions = 'You only emit verified city data.'
 *   override readonly outputSchema = citySchema  // OutputSchema<CityAnswer>
 * }
 *
 * const { value } = await brain.agent(CityAgent).input('Capital of France?').run()
 * //      ^? CityAnswer — runner is typed from the class generic
 * ```
 *
 * The generic threads `T` through `BrainManager.agent(Class)` →
 * `AgentRunner<T>` → `AgentGenerateResult<T>`. Subclasses that
 * don't declare an output type stay `Agent<never>` and `run()`
 * returns `AgentResult` exactly as before.
 */

import type { MCPServer } from './mcp_server.ts'
import type { OutputSchema } from './output_schema.ts'
import type { ModelTier } from './types.ts'
import type { Tool } from './tool.ts'

export abstract class Agent<T = never> {
  /** System prompt — the persona / instructions Claude sees on every turn. */
  abstract readonly instructions: string

  /** Tools the agent can call. Empty array → the model answers without tools. */
  readonly tools: readonly Tool[] = []

  /**
   * MCP servers exposed to the agent. Anthropic's backend connects
   * to them and surfaces their tools to the model alongside any
   * locally-registered `tools`. Empty array (or omitted) → no MCP
   * servers; the agent runs with just `tools` (or no tools at all).
   */
  readonly mcpServers: readonly MCPServer[] = []

  /** Override the configured default provider. Default = brain's default provider. */
  readonly provider?: string

  /** Explicit model ID. Wins over `tier`. */
  readonly model?: string

  /** Tier sugar. Default `'powerful'` for agentic work. */
  readonly tier: ModelTier = 'powerful'

  /**
   * Safety ceiling on the agentic loop. Default `10`. Hitting it
   * returns a result with `stopReason: 'max_iterations'`; the loop
   * doesn't throw because partial progress (assistant messages, tool
   * results) is usually still useful to surface.
   */
  readonly maxIterations: number = 10

  /** Hard cap on per-call response tokens. Default `4096`. */
  readonly maxTokens: number = 4096

  /**
   * Structured-output schema. Set on subclasses that extend
   * `Agent<SomeType>` to declare the agent always returns that
   * shape; `BrainManager.agent(Class)` then types the runner
   * automatically so `.run()` returns `AgentGenerateResult<T>`
   * without a per-call `.output(schema)`.
   *
   * Leave unset on `Agent<never>` subclasses (no structured
   * output). The runner falls back to the standard tool-loop path
   * and returns `AgentResult`.
   *
   * Apps that want a per-call override still chain
   * `.output(otherSchema)` — that wins over the class-side value.
   */
  readonly outputSchema?: OutputSchema<T>
}
