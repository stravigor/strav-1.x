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
 * V1 makes the configuration declarative-only — apps that need
 * runtime knobs (per-request model overrides, dynamic tool sets)
 * use `BrainManager.runTools(...)` directly. Adding per-instance
 * overrides on the Agent class is a future ergonomic slice.
 */

import type { ModelTier } from './types.ts'
import type { Tool } from './tool.ts'

export abstract class Agent {
  /** System prompt — the persona / instructions Claude sees on every turn. */
  abstract readonly instructions: string

  /** Tools the agent can call. Empty array → the model answers without tools. */
  readonly tools: readonly Tool[] = []

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
}
