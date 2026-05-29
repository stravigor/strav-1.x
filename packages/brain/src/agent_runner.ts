/**
 * `AgentRunner` — fluent builder returned by `BrainManager.agent(Class)`.
 *
 * Carries the agent instance + an input message + an optional
 * per-run context bag. `run()` translates the agent's declarative
 * configuration into a `runWithTools` call and returns the
 * `AgentResult`.
 *
 * Designed to chain: `brain.agent(R).input(text).context({...}).run()`.
 * Apps that need the full Message-array surface bypass the runner
 * and call `BrainManager.runTools(messages, tools, options)` directly.
 */

import type { Agent } from './agent.ts'
import type { AgentResult } from './agent_result.ts'
import type { BrainManager } from './brain_manager.ts'
import type { RunWithToolsOptions } from './provider.ts'
import type { Message } from './types.ts'

export class AgentRunner {
  private prompt: string | undefined
  private contextBag: Record<string, unknown> = {}

  constructor(
    private readonly brain: BrainManager,
    private readonly agent: Agent,
  ) {}

  /** Set the user input. Required before `run()`. */
  input(text: string): this {
    this.prompt = text
    return this
  }

  /**
   * Attach context that every tool's `execute(input, ctx)` will see
   * on `ctx.context`. Useful for per-request data the agent's tools
   * need but the model shouldn't see directly (auth identity,
   * tenant id, request-id for tracing).
   */
  context(data: Record<string, unknown>): this {
    this.contextBag = { ...this.contextBag, ...data }
    return this
  }

  async run(): Promise<AgentResult> {
    if (this.prompt === undefined) {
      throw new Error('AgentRunner.run: input() must be called before run().')
    }
    const messages: Message[] = [{ role: 'user', content: this.prompt }]
    const options: RunWithToolsOptions = {
      tier: this.agent.tier,
      maxTokens: this.agent.maxTokens,
      system: this.agent.instructions,
      maxIterations: this.agent.maxIterations,
      context: this.contextBag,
    }
    if (this.agent.model !== undefined) options.model = this.agent.model
    if (this.agent.provider !== undefined) options.provider = this.agent.provider
    if (this.agent.mcpServers.length > 0) options.mcpServers = this.agent.mcpServers
    return this.brain.runTools(messages, this.agent.tools, options)
  }
}
