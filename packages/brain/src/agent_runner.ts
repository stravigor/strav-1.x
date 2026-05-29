/**
 * `AgentRunner` — fluent builder returned by `BrainManager.agent(Class)`.
 *
 * Carries the agent instance + an input message + an optional
 * per-run context bag + an optional structured-output schema.
 * `run()` translates the agent's declarative configuration into
 * either a `runWithTools` call (default) or a `generate` call (when
 * `.output(schema)` was used) and returns the matching result type.
 *
 * Designed to chain:
 *
 * ```ts
 * brain.agent(R).input(text).context({...}).run()
 * brain.agent(R).input(text).output(schema).run()  // → AgentGenerateResult<T>
 * ```
 *
 * Apps that need the full Message-array surface bypass the runner
 * and call `BrainManager.runTools(messages, tools, options)` or
 * `BrainManager.generate(input, schema, options)` directly.
 */

import type { Agent } from './agent.ts'
import type { AgentGenerateResult } from './agent_generate_result.ts'
import type { AgentResult } from './agent_result.ts'
import type { AgentStreamEvent } from './agent_stream_event.ts'
import type { BrainManager } from './brain_manager.ts'
import { BrainError } from './brain_error.ts'
import type { OutputSchema } from './output_schema.ts'
import type { ChatOptions, Message } from './types.ts'
import type { RunWithToolsOptions } from './provider.ts'

/**
 * Conditional return shape for `AgentRunner.run()`. With the default
 * generic (`T = never`), `run()` returns `AgentResult` — the
 * tool-loop shape. When the runner has been switched into
 * structured-output mode via `.output(schema)`, `T` carries the
 * inferred type and `run()` returns `AgentGenerateResult<T>`.
 *
 * The `[T] extends [never]` form is the standard "is this still the
 * default never?" check — `T extends never` would distribute over
 * union types and break.
 */
export type AgentRunResult<T> = [T] extends [never] ? AgentResult : AgentGenerateResult<T>

export class AgentRunner<T = never> {
  private prompt: string | undefined
  private contextBag: Record<string, unknown> = {}
  private schema: OutputSchema<T> | undefined

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

  /**
   * Switch the runner into structured-output mode. `run()` then
   * delegates to `BrainManager.generate(...)` and returns an
   * `AgentGenerateResult<U>` shaped to the supplied schema.
   *
   * V1 caveat: structured output and tool use can't be combined yet.
   * Agents that declare `tools` or `mcpServers` AND call `.output()`
   * throw a `BrainError` at `run()` with a clear "this combination is
   * deferred" message. Apps that need both today run them in two
   * steps — `runTools(...)` for the loop, then `generate(...)` for
   * the structured summary.
   */
  output<U>(schema: OutputSchema<U>): AgentRunner<U> {
    // Mutate in place + cast — the runtime state is a single object;
    // the generic narrows only the static return type. This avoids
    // cloning the prompt + contextBag fields.
    this.schema = schema as unknown as OutputSchema<T>
    return this as unknown as AgentRunner<U>
  }

  /**
   * Streaming variant of `run()`. Returns an
   * `AsyncIterable<AgentStreamEvent<T>>` — yields text deltas,
   * tool-use/result boundaries, and a terminal `stop` event with
   * the full trace.
   *
   * Default (no `.output(schema)` set): the terminal `stop` has the
   * plain shape and `T` defaults to `never`.
   *
   * With `.output(schema)`: the terminal `stop` event carries the
   * parsed `value: T` + raw `text` alongside the loop bookkeeping,
   * and the runner delegates to
   * `BrainManager.streamGenerateWithTools`.
   */
  stream(): AsyncIterable<AgentStreamEvent<T>> {
    if (this.prompt === undefined) {
      throw new BrainError('AgentRunner.stream: input() must be called before stream().')
    }
    const messages: Message[] = [{ role: 'user', content: this.prompt }]
    const options: RunWithToolsOptions = {
      ...this.buildChatOptions(),
      maxIterations: this.agent.maxIterations,
      context: this.contextBag,
    }
    if (this.agent.mcpServers.length > 0) options.mcpServers = this.agent.mcpServers
    if (this.schema !== undefined) {
      return this.brain.streamGenerateWithTools<T>(
        messages,
        this.schema,
        this.agent.tools,
        options,
      )
    }
    return this.brain.streamTools(messages, this.agent.tools, options) as AsyncIterable<
      AgentStreamEvent<T>
    >
  }

  async run(): Promise<AgentRunResult<T>> {
    if (this.prompt === undefined) {
      throw new BrainError('AgentRunner.run: input() must be called before run().')
    }
    const messages: Message[] = [{ role: 'user', content: this.prompt }]

    if (this.schema !== undefined) {
      const hasTools = this.agent.tools.length > 0 || this.agent.mcpServers.length > 0
      if (hasTools) {
        const toolOptions: RunWithToolsOptions = {
          ...this.buildChatOptions(),
          maxIterations: this.agent.maxIterations,
          context: this.contextBag,
        }
        if (this.agent.mcpServers.length > 0) toolOptions.mcpServers = this.agent.mcpServers
        const result = await this.brain.generateWithTools<T>(
          messages,
          this.schema,
          this.agent.tools,
          toolOptions,
        )
        return result as AgentRunResult<T>
      }
      const generateOptions = this.buildChatOptions()
      const result = await this.brain.generate<T>(messages, this.schema, generateOptions)
      const generateResult: AgentGenerateResult<T> = {
        value: result.value,
        text: result.text,
        messages: [
          ...messages,
          { role: 'assistant', content: result.text },
        ],
        iterations: 0,
        stopReason: result.stopReason ?? 'stop',
        usage: result.usage,
      }
      return generateResult as AgentRunResult<T>
    }

    const options: RunWithToolsOptions = {
      ...this.buildChatOptions(),
      maxIterations: this.agent.maxIterations,
      context: this.contextBag,
    }
    if (this.agent.mcpServers.length > 0) options.mcpServers = this.agent.mcpServers
    const result = await this.brain.runTools(messages, this.agent.tools, options)
    return result as AgentRunResult<T>
  }

  private buildChatOptions(): ChatOptions {
    const options: ChatOptions = {
      tier: this.agent.tier,
      maxTokens: this.agent.maxTokens,
      system: this.agent.instructions,
    }
    if (this.agent.model !== undefined) options.model = this.agent.model
    if (this.agent.provider !== undefined) options.provider = this.agent.provider
    return options
  }
}
