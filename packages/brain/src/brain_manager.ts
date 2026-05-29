/**
 * `BrainManager` — the per-app facade apps inject and call.
 *
 * Holds the configured `Provider` registry + the default-provider key
 * + the tier-to-model map. Apps call `chat / stream / countTokens`
 * with framework-native types; the manager resolves which provider
 * runs the call (default unless `options.provider` overrides),
 * applies tier sugar (`options.tier` → concrete `model`), and
 * delegates.
 *
 * Constructed by `BrainProvider` at boot from `config.brain`. Apps
 * also build one inline for tests:
 *
 * ```ts
 * const brain = new BrainManager({
 *   default: 'anthropic',
 *   providers: { anthropic: stubProvider },
 * })
 * ```
 */

import type { Agent } from './agent.ts'
import type { AgentResult } from './agent_result.ts'
import type { AgentStreamEvent } from './agent_stream_event.ts'
import type { MCPServer } from './mcp_server.ts'
import type { AgentGenerateResult } from './agent_generate_result.ts'
import type { OutputSchema } from './output_schema.ts'
import { AgentRunner } from './agent_runner.ts'
import { BrainError } from './brain_error.ts'
import type { ModelTier } from './types.ts'
import type {
  AudioSource,
  ChatOptions,
  ChatResult,
  EmbedOptions,
  EmbedResult,
  GenerateResult,
  Message,
  StreamEvent,
  TranscribeOptions,
  TranscribeResult,
} from './types.ts'
import type { Provider, RunWithToolsOptions } from './provider.ts'
import type { Tool } from './tool.ts'
import { DEFAULT_TIERS } from './brain_config.ts'

/** Container-aware Agent constructor resolver — `BrainProvider` installs one wired to `app.resolve(...)`. */
export type AgentResolver = <A extends Agent<unknown>>(cls: new (...args: never[]) => A) => A

export interface BrainManagerOptions {
  /** Name of the default provider — must exist in `providers`. */
  default: string
  /** Provider registry keyed by name. */
  providers: Record<string, Provider>
  /** Tier-to-model overrides; merged on top of the framework defaults. */
  tiers?: Partial<Record<ModelTier, string>>
  /** Default for `ChatOptions.cache` when the call site doesn't pass one. */
  defaultCache?: boolean
  /**
   * Default MCP servers used on every `runTools` call when the per-call
   * options don't specify them. Per-call `mcpServers` replaces the
   * default outright (no merge) — apps that want additive behavior
   * concat at the call site.
   */
  defaultMcpServers?: readonly MCPServer[]
}

export class BrainManager {
  readonly defaultProvider: string
  private readonly providers: Map<string, Provider>
  private readonly tiers: Record<ModelTier, string>
  private readonly defaultCache: boolean
  private readonly defaultMcpServers: readonly MCPServer[]

  constructor(options: BrainManagerOptions) {
    if (!options.providers[options.default]) {
      throw new BrainError(
        `BrainManager: default provider "${options.default}" is not registered.`,
        { context: { default: options.default, available: Object.keys(options.providers) } },
      )
    }
    this.defaultProvider = options.default
    this.providers = new Map(Object.entries(options.providers))
    this.tiers = { ...DEFAULT_TIERS, ...(options.tiers ?? {}) }
    this.defaultCache = options.defaultCache ?? false
    this.defaultMcpServers = options.defaultMcpServers ?? []
  }

  /** Resolve a provider by name. Default when no name passed. Throws when unknown. */
  provider(name?: string): Provider {
    const key = name ?? this.defaultProvider
    const provider = this.providers.get(key)
    if (!provider) {
      throw new BrainError(`BrainManager: no provider registered under "${key}".`, {
        context: { requested: key, available: [...this.providers.keys()] },
      })
    }
    return provider
  }

  /**
   * One-shot chat: send the messages, await the full reply.
   *
   * Accepts either a bare prompt string (treated as a single
   * user-role message) or a typed `Message[]` for multi-turn /
   * pre-built conversations.
   */
  async chat(input: string | readonly Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return this.provider(options.provider).chat(messages, resolved)
  }

  /**
   * Stream the reply. Yields a `text` event per delta and a single
   * terminal `stop` event with usage + stop-reason. Apps that want
   * just the final message use `chat()` instead — this surface is
   * for UI streaming.
   */
  stream(
    input: string | readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return this.provider(options.provider).stream(messages, resolved)
  }

  /**
   * Count input tokens for the given messages + options. Returns
   * `null` when the configured provider doesn't expose a token count
   * helper (no `countTokens` method) — apps can fall back to a local
   * estimator at the call site.
   */
  async countTokens(
    input: string | readonly Message[],
    options: ChatOptions = {},
  ): Promise<number | null> {
    const provider = this.provider(options.provider)
    if (!provider.countTokens) return null
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return provider.countTokens(messages, resolved)
  }

  /**
   * Run an agentic loop: send `messages` + `tools` to the model;
   * execute any tool the model calls; loop until the model returns
   * a terminal `stop_reason` (`'end_turn'`) or `maxIterations` is hit.
   *
   * Throws `BrainError` when the configured provider doesn't
   * implement `runWithTools` (V1: OpenAI / Gemini / DeepSeek providers
   * don't yet — only `AnthropicProvider`).
   */
  async runTools(
    input: string | readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): Promise<AgentResult> {
    const provider = this.provider(options.provider)
    if (!provider.runWithTools) {
      throw new BrainError(
        `BrainManager.runTools: provider "${provider.name}" does not implement runWithTools. Use a provider that supports tool use (V1: Anthropic).`,
        { context: { provider: provider.name } },
      )
    }
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options) as RunWithToolsOptions
    // MCP defaults — per-call override (when present) replaces the
    // configured list outright; apps that want concat behavior
    // construct the merged array themselves and pass it in.
    if (resolved.mcpServers === undefined && this.defaultMcpServers.length > 0) {
      resolved.mcpServers = this.defaultMcpServers
    }
    return provider.runWithTools(messages, tools, resolved)
  }

  /**
   * Streaming variant of `generateWithTools`. Yields
   * `AgentStreamEvent<T>`s as the loop progresses; the terminal
   * `stop` event carries the parsed value + raw JSON text. Throws
   * `BrainError` when the provider lacks
   * `streamWithToolsAndSchema` (V1: all three providers
   * implement it).
   */
  streamGenerateWithTools<T>(
    input: string | readonly Message[],
    schema: OutputSchema<T>,
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): AsyncIterable<AgentStreamEvent<T>> {
    const provider = this.provider(options.provider)
    if (!provider.streamWithToolsAndSchema) {
      throw new BrainError(
        `BrainManager.streamGenerateWithTools: provider "${provider.name}" does not implement streamWithToolsAndSchema.`,
        { context: { provider: provider.name } },
      )
    }
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options) as RunWithToolsOptions
    if (resolved.mcpServers === undefined && this.defaultMcpServers.length > 0) {
      resolved.mcpServers = this.defaultMcpServers
    }
    return provider.streamWithToolsAndSchema<T>(messages, tools, schema, resolved)
  }

  /**
   * Tool-loop + structured output combined. Runs the agentic loop
   * with the supplied `tools` while pinning the output to `schema`
   * on every turn; returns the parsed value when the model finally
   * answers without calling a tool. MCP defaults + tier resolution
   * + provider routing match `runTools` / `generate`.
   *
   * Throws `BrainError` when the chosen provider doesn't implement
   * `runWithToolsAndSchema`. V1: all three providers do.
   */
  async generateWithTools<T>(
    input: string | readonly Message[],
    schema: OutputSchema<T>,
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): Promise<AgentGenerateResult<T>> {
    const provider = this.provider(options.provider)
    if (!provider.runWithToolsAndSchema) {
      throw new BrainError(
        `BrainManager.generateWithTools: provider "${provider.name}" does not implement runWithToolsAndSchema.`,
        { context: { provider: provider.name } },
      )
    }
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options) as RunWithToolsOptions
    if (resolved.mcpServers === undefined && this.defaultMcpServers.length > 0) {
      resolved.mcpServers = this.defaultMcpServers
    }
    return provider.runWithToolsAndSchema<T>(messages, tools, schema, resolved)
  }

  /**
   * Streaming variant of `runTools`. Yields `AgentStreamEvent`s
   * as the agentic loop progresses — text deltas during model
   * turns, `tool_use` / `tool_result` boundaries around tool
   * execution, `iteration_start` / `iteration_end` per round, a
   * terminal `stop` with the full trace + usage.
   *
   * Throws `BrainError` when the configured provider doesn't
   * implement `streamWithTools`.
   */
  streamTools(
    input: string | readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): AsyncIterable<AgentStreamEvent> {
    const provider = this.provider(options.provider)
    if (!provider.streamWithTools) {
      throw new BrainError(
        `BrainManager.streamTools: provider "${provider.name}" does not implement streamWithTools.`,
        { context: { provider: provider.name } },
      )
    }
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options) as RunWithToolsOptions
    if (resolved.mcpServers === undefined && this.defaultMcpServers.length > 0) {
      resolved.mcpServers = this.defaultMcpServers
    }
    return provider.streamWithTools(messages, tools, resolved)
  }

  /**
   * Structured output. Sends `input` to the configured (or
   * `options.provider`-overridden) provider with the JSON-Schema
   * constraint described by `schema`; returns the parsed object.
   *
   * Throws `BrainError` when the chosen provider doesn't implement
   * `generate`. All three V1 providers (Anthropic, OpenAI, Gemini)
   * do.
   */
  async generate<T>(
    input: string | readonly Message[],
    schema: OutputSchema<T>,
    options: ChatOptions = {},
  ): Promise<GenerateResult<T>> {
    const provider = this.provider(options.provider)
    if (!provider.generate) {
      throw new BrainError(
        `BrainManager.generate: provider "${provider.name}" does not implement generate.`,
        { context: { provider: provider.name } },
      )
    }
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return provider.generate<T>(messages, schema, resolved)
  }

  /**
   * Turn one or more text inputs into embedding vectors. Accepts
   * either a single string (returns one vector) or an array
   * (batch — returns one vector per input in the same order).
   *
   * Throws `BrainError` when the configured (or
   * `options.provider`-overridden) provider doesn't implement
   * `embed`. V1: OpenAI, Gemini, Ollama support it; Anthropic +
   * DeepSeek throw with a clear "route to a different provider"
   * message.
   */
  async embed(
    input: string | readonly string[],
    options: EmbedOptions = {},
  ): Promise<EmbedResult> {
    const provider = this.provider(options.provider)
    if (!provider.embed) {
      throw new BrainError(
        `BrainManager.embed: provider "${provider.name}" does not implement embed. Route to a provider with an embeddings API (V1: OpenAI / Gemini / Ollama).`,
        { context: { provider: provider.name } },
      )
    }
    const texts = typeof input === 'string' ? [input] : input
    return provider.embed(texts, options)
  }

  /**
   * Transcribe one audio clip to text. Complements `AudioBlock`
   * (which sends audio + a text prompt together to a multimodal
   * chat model) by exposing the dedicated transcription endpoint
   * where the provider has one. Apps that already have an
   * `AudioBlock` can pass its `source` directly.
   *
   * Throws `BrainError` when the configured (or
   * `options.provider`-overridden) provider doesn't implement
   * `transcribe`. V1: OpenAI / Ollama (Whisper / gpt-4o-transcribe
   * / local) and Gemini (chat-wrap fallback); Anthropic +
   * DeepSeek throw.
   */
  async transcribe(
    audio: AudioSource,
    options: TranscribeOptions = {},
  ): Promise<TranscribeResult> {
    const provider = this.provider(options.provider)
    if (!provider.transcribe) {
      throw new BrainError(
        `BrainManager.transcribe: provider "${provider.name}" does not implement transcribe. Route to a provider with audio support (V1: OpenAI / Ollama / Gemini).`,
        { context: { provider: provider.name } },
      )
    }
    return provider.transcribe(audio, options)
  }

  /**
   * Resolve an `Agent` subclass from the container and return an
   * `AgentRunner` ready to receive `input(...)` and `run()`. Apps
   * `@inject()`-decorate their Agent subclass so constructor
   * injection of dependencies (Repositories, services, etc.) flows
   * through normally.
   *
   * When the agent subclass extends `Agent<T>` for some `T` and
   * declares `outputSchema`, the returned runner is typed as
   * `AgentRunner<T>` and the schema is pre-applied — `.run()`
   * returns `AgentGenerateResult<T>` without a per-call
   * `.output(schema)`. Apps can still chain `.output(otherSchema)`
   * to override.
   */
  agent<T = never>(
    AgentClass: new (...args: never[]) => Agent<T>,
    instance?: Agent<T>,
  ): AgentRunner<T> {
    const agent = instance ?? this.resolveAgent(AgentClass)
    const runner = new AgentRunner<T>(this, agent)
    if (agent.outputSchema !== undefined) {
      return runner.output(agent.outputSchema)
    }
    return runner
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private resolveAgent<A extends Agent<unknown>>(AgentClass: new (...args: never[]) => A): A {
    if (this.agentResolver) return this.agentResolver(AgentClass)
    // Fallback: assume the Agent class is constructible without args.
    // Apps that need DI on the agent register a resolver via
    // `setAgentResolver` (BrainProvider wires this to the container).
    return new (AgentClass as unknown as new () => A)()
  }

  /**
   * Internal — `BrainProvider` calls this at boot to plug in the
   * container's resolution function so `brain.agent(MyAgent)` runs
   * `app.resolve(MyAgent)` under the hood. Apps that build a
   * `BrainManager` by hand for tests can leave this unset and pass
   * a pre-constructed agent to `brain.agent(_, instance)`.
   */
  setAgentResolver(resolver: AgentResolver): void {
    this.agentResolver = resolver
  }

  private agentResolver: AgentResolver | undefined

  private applyDefaults(options: ChatOptions): ChatOptions {
    const resolved: ChatOptions = { ...options }
    if (resolved.model === undefined && resolved.tier !== undefined) {
      resolved.model = this.tiers[resolved.tier]
    }
    if (resolved.cache === undefined && this.defaultCache) {
      resolved.cache = true
    }
    return resolved
  }
}

function normalizeInput(input: string | readonly Message[]): readonly Message[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  return input
}
