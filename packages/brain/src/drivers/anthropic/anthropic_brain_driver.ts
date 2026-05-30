/**
 * `AnthropicBrainDriver` — implementation of `Provider` backed by the
 * official `@anthropic-ai/sdk`.
 *
 * Responsibilities:
 *   1. Hold a singleton `Anthropic` client instance for the
 *      configured API key + base URL.
 *   2. Translate the framework's `ChatOptions` / `Message` shapes
 *      into Anthropic's `MessageCreateParams` (system as `TextBlock[]`
 *      with `cache_control` when requested; messages with per-block
 *      cache flags translated likewise; `thinking` mapped to
 *      `ThinkingConfigParam`; `effort` placed under `output_config`).
 *   3. Translate the response back to `ChatResult` — flatten the
 *      content blocks into a single `text` string, surface usage with
 *      cache-hit counters, and pass the raw `Message` through on `.raw`.
 *   4. Stream via `client.messages.stream()` and yield the framework
 *      `StreamEvent` union — `text` deltas plus a terminal `stop`
 *      event with usage + stop reason.
 *
 * Errors from the SDK propagate; apps that want provider-specific
 * recovery can `instanceof Anthropic.RateLimitError` etc. The brain
 * facade wraps the call site in `BrainError` only for invariants the
 * facade owns (e.g. "no provider configured").
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from '../../agent_result.ts'
import type { AnthropicProviderConfig } from '../../brain_config.ts'
import { DEFAULT_MODEL } from '../../brain_config.ts'
import { BrainError } from '../../brain_error.ts'
import type {
  BrainDriver,
  RunWithToolsOptions,
  RunWithToolsOptionsWithSuspend,
} from '../../brain_driver.ts'
import type { SuspendedRun } from '../../suspended_run.ts'
import type { Tool } from '../../tool.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  GenerateResult,
  Message,
  StreamEvent,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types.ts'
import type { AgentGenerateResult } from '../../agent_generate_result.ts'
import type { AgentStreamEvent } from '../../agent_stream_event.ts'
import { parseGenerated, type OutputSchema } from '../../output_schema.ts'
import { runToolWithRecovery } from '../../tool_runner.ts'
import {
  checkAborted,
  collectText,
  needsBetaRouting,
  reqOpts,
} from './anthropic_helpers.ts'
import {
  buildAnthropicMessageParams,
  toMessageParam,
} from './anthropic_message_builder.ts'
import {
  addAnthropicUsage,
  fromAnthropicContent,
  toAnthropicChatResult,
  toAnthropicUsage,
} from './anthropic_response_mapper.ts'
import {
  createNonStreamLoopState,
  injectToolsAndMCP,
  runAnthropicNonStreamIteration,
} from './anthropic_tool_loop.ts'

export class AnthropicBrainDriver implements BrainDriver {
  readonly name: string
  private readonly client: Anthropic
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number
  private readonly betas: readonly string[]

  constructor(
    name: string,
    config: AnthropicProviderConfig,
    options: { client?: Anthropic } = {},
  ) {
    this.name = name
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096
    this.betas = config.betas ?? []
    // `client` injection point — tests pass a stub; apps that want a
    // pre-configured SDK instance (custom retry, fetch transport, etc.)
    // build their own and hand it over here.
    this.client =
      options.client ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
      })
  }

  async chat(messages: readonly Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const params = this.buildParams(messages, options)
    const useBeta = needsBetaRouting(params)
    const response = useBeta
      ? ((await this.client.beta.messages.create(
          params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
          reqOpts(options),
        )) as unknown as Anthropic.Message)
      : await this.client.messages.create(params, reqOpts(options))
    return toAnthropicChatResult(response)
  }

  async *stream(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const params = this.buildParams(messages, options)
    const stream = needsBetaRouting(params)
      ? this.client.beta.messages.stream(
          params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
          reqOpts(options),
        )
      : this.client.messages.stream(params, reqOpts(options))
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'text', delta: event.delta.text }
      }
    }
    const final = await stream.finalMessage()
    yield {
      type: 'stop',
      stopReason: final.stop_reason,
      usage: toAnthropicUsage(final.usage),
    }
  }

  async countTokens(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): Promise<number> {
    const base = this.buildParams(messages, options)
    // count_tokens only accepts a subset of MessageCreateParams; build
    // a focused payload that matches what apps actually need to budget.
    const result = await this.client.messages.countTokens(
      {
        model: base.model,
        messages: base.messages,
        ...(base.system !== undefined ? { system: base.system } : {}),
        ...(base.thinking !== undefined ? { thinking: base.thinking } : {}),
      },
      reqOpts(options),
    )
    return result.input_tokens
  }

  /**
   * Agentic loop. Send → detect tool_use blocks → execute → append
   * tool_result → re-send, until the model returns `end_turn` or
   * the iteration ceiling is hit.
   *
   * Tools are passed once on every call — Anthropic doesn't carry
   * tool state across requests; the model rediscovers them from the
   * `tools` array each turn. Apps that care about cache hits keep
   * the tool list stable across runs.
   */
  runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptionsWithSuspend,
  ): Promise<AgentResult | SuspendedRun>
  runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): Promise<AgentResult>
  async runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): Promise<AgentResult | SuspendedRun> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const state = createNonStreamLoopState(messages)
    const mcpServers = options.mcpServers ?? []
    const buildParams = (msgs: readonly Message[]) =>
      injectToolsAndMCP(this.buildParams(msgs, options), { tools, mcpServers })

    while (true) {
      const outcome = await runAnthropicNonStreamIteration({
        state,
        toolMap,
        maxIterations,
        client: this.client,
        buildParams,
        options,
        suspendCheck: options.shouldSuspend,
      })
      if (outcome.kind === 'continue') continue
      if (outcome.kind === 'suspended') {
        return {
          status: 'suspended',
          pendingToolCalls: outcome.pendingToolCalls,
          state: {
            messages: state.workingMessages,
            iterations: state.iterations,
            usage: state.aggregated,
          },
        }
      }
      return {
        text: outcome.assistantText,
        messages: state.workingMessages,
        iterations: state.iterations,
        stopReason: outcome.kind === 'max_iterations' ? 'max_iterations' : outcome.stopReason,
        usage: state.aggregated,
      }
    }
  }

  async runWithToolsAndSchema<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions = {},
  ): Promise<AgentGenerateResult<T>> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const state = createNonStreamLoopState(messages)
    const mcpServers = options.mcpServers ?? []
    const buildParams = (msgs: readonly Message[]) => {
      const params = injectToolsAndMCP(this.buildParams(msgs, options), { tools, mcpServers })
      params.output_config = {
        ...(params.output_config ?? {}),
        format: { type: 'json_schema', schema: schema.jsonSchema },
      }
      return params
    }

    while (true) {
      const outcome = await runAnthropicNonStreamIteration({
        state,
        toolMap,
        maxIterations,
        client: this.client,
        buildParams,
        options,
        // Schema variant doesn't support suspension — same as OpenAI.
        suspendCheck: undefined,
      })
      if (outcome.kind === 'continue') continue
      if (outcome.kind === 'suspended') {
        throw new BrainError(
          'AnthropicBrainDriver: runWithToolsAndSchema received a suspension outcome but does not support it.',
        )
      }
      // For max_iterations the assistantText may be empty (last turn
      // was a tool_use) — surface what we have; parseGenerated will
      // likely fail and that's the correct signal.
      return {
        value: parseGenerated(outcome.assistantText, schema),
        text: outcome.assistantText,
        messages: state.workingMessages,
        iterations: state.iterations,
        stopReason: outcome.kind === 'max_iterations' ? 'max_iterations' : outcome.stopReason,
        usage: state.aggregated,
      }
    }
  }

  async *streamWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): AsyncIterable<AgentStreamEvent> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const workingMessages: Message[] = [...messages]
    const aggregated: ChatUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    let iterations = 0

    const mcpServers = options.mcpServers ?? []
    const useMcpBeta = mcpServers.length > 0

    while (true) {
      checkAborted(options.signal)
      yield { type: 'iteration_start', iteration: iterations }

      const params = this.buildParams(workingMessages, options) as Anthropic.MessageCreateParamsNonStreaming & {
        mcp_servers?: Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition[]
      }
      params.tools = [
        // Server tools placed first when present (from buildParams).
        ...((params.tools ?? []) as Anthropic.ToolUnion[]),
        ...tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...mcpServers
          .filter((s) => s.tools?.enabled !== false)
          .map((s) => ({
            type: 'mcp_toolset' as const,
            mcp_server_name: s.name,
            ...(s.tools?.allowedTools ? { allowed_tools: [...s.tools.allowedTools] } : {}),
          })),
      ] as unknown as Anthropic.MessageCreateParams['tools']

      if (useMcpBeta) {
        params.mcp_servers = mcpServers.map((s) => {
          const def: Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition = {
            type: 'url',
            name: s.name,
            url: s.url,
          }
          if (s.authorizationToken !== undefined) def.authorization_token = s.authorizationToken
          return def
        })
        const baseBetas = (params as { betas?: readonly string[] }).betas ?? []
        ;(params as { betas?: string[] }).betas = baseBetas.includes('mcp-client-2025-11-20')
          ? [...baseBetas]
          : [...baseBetas, 'mcp-client-2025-11-20']
      }

      const stream = needsBetaRouting(params)
        ? this.client.beta.messages.stream(
            params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
            reqOpts(options),
          )
        : this.client.messages.stream(params, reqOpts(options))

      // Track tool_use content blocks by their stream index so
      // `input_json_delta` events can be paired with the correct id.
      // Anthropic's streaming protocol issues a `content_block_start`
      // carrying the tool's id + name, then a sequence of
      // `input_json_delta`s with `partial_json` chunks, then a
      // `content_block_stop`.
      const toolBlockIdByIndex = new Map<number, string>()
      for await (const event of stream) {
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          toolBlockIdByIndex.set(event.index, event.content_block.id)
          yield {
            type: 'tool_use_start',
            id: event.content_block.id,
            name: event.content_block.name,
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && event.delta.text.length > 0) {
            yield { type: 'text', delta: event.delta.text }
          } else if (event.delta.type === 'input_json_delta') {
            const id = toolBlockIdByIndex.get(event.index)
            if (id !== undefined && event.delta.partial_json.length > 0) {
              yield { type: 'tool_use_delta', id, argsDelta: event.delta.partial_json }
            }
          }
        }
      }
      const final = (await stream.finalMessage()) as unknown as Anthropic.Message
      addAnthropicUsage(aggregated, final.usage)
      const finishReason: string | null = final.stop_reason ?? null

      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      workingMessages.push({
        role: 'assistant',
        content: fromAnthropicContent(final.content),
      })

      if (final.stop_reason !== 'tool_use') {
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'end_turn',
          iterations,
          usage: aggregated,
          messages: workingMessages,
        }
        return
      }

      const toolUseBlocks = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      const resultBlocks: ContentBlock[] = []
      for (const block of toolUseBlocks) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        const { content, isError } = await runToolWithRecovery(
          toolMap.get(block.name),
          block.name,
          block.id,
          block.input,
          options,
        )
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: block.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: block.id,
          name: block.name,
          content,
          isError,
        }
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        yield {
          type: 'stop',
          stopReason: 'max_iterations',
          iterations,
          usage: aggregated,
          messages: workingMessages,
        }
        return
      }
    }
  }

  async *streamWithToolsAndSchema<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions = {},
  ): AsyncIterable<AgentStreamEvent<T>> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const workingMessages: Message[] = [...messages]
    const aggregated: ChatUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    let iterations = 0

    const mcpServers = options.mcpServers ?? []
    const useMcpBeta = mcpServers.length > 0

    while (true) {
      checkAborted(options.signal)
      yield { type: 'iteration_start', iteration: iterations }

      const params = this.buildParams(workingMessages, options) as Anthropic.MessageCreateParamsNonStreaming & {
        mcp_servers?: Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition[]
      }
      params.tools = [
        // Server tools placed first when present (from buildParams).
        ...((params.tools ?? []) as Anthropic.ToolUnion[]),
        ...tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...mcpServers
          .filter((s) => s.tools?.enabled !== false)
          .map((s) => ({
            type: 'mcp_toolset' as const,
            mcp_server_name: s.name,
            ...(s.tools?.allowedTools ? { allowed_tools: [...s.tools.allowedTools] } : {}),
          })),
      ] as unknown as Anthropic.MessageCreateParams['tools']
      params.output_config = {
        ...(params.output_config ?? {}),
        format: { type: 'json_schema', schema: schema.jsonSchema },
      }

      if (useMcpBeta) {
        params.mcp_servers = mcpServers.map((s) => {
          const def: Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition = {
            type: 'url',
            name: s.name,
            url: s.url,
          }
          if (s.authorizationToken !== undefined) def.authorization_token = s.authorizationToken
          return def
        })
        const baseBetas = (params as { betas?: readonly string[] }).betas ?? []
        ;(params as { betas?: string[] }).betas = baseBetas.includes('mcp-client-2025-11-20')
          ? [...baseBetas]
          : [...baseBetas, 'mcp-client-2025-11-20']
      }

      const stream = needsBetaRouting(params)
        ? this.client.beta.messages.stream(
            params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
            reqOpts(options),
          )
        : this.client.messages.stream(params, reqOpts(options))

      // Track tool_use content blocks by their stream index so
      // `input_json_delta` events can be paired with the correct id.
      // Anthropic's streaming protocol issues a `content_block_start`
      // carrying the tool's id + name, then a sequence of
      // `input_json_delta`s with `partial_json` chunks, then a
      // `content_block_stop`.
      const toolBlockIdByIndex = new Map<number, string>()
      for await (const event of stream) {
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          toolBlockIdByIndex.set(event.index, event.content_block.id)
          yield {
            type: 'tool_use_start',
            id: event.content_block.id,
            name: event.content_block.name,
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && event.delta.text.length > 0) {
            yield { type: 'text', delta: event.delta.text }
          } else if (event.delta.type === 'input_json_delta') {
            const id = toolBlockIdByIndex.get(event.index)
            if (id !== undefined && event.delta.partial_json.length > 0) {
              yield { type: 'tool_use_delta', id, argsDelta: event.delta.partial_json }
            }
          }
        }
      }
      const final = (await stream.finalMessage()) as unknown as Anthropic.Message
      addAnthropicUsage(aggregated, final.usage)
      const finishReason: string | null = final.stop_reason ?? null
      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      workingMessages.push({
        role: 'assistant',
        content: fromAnthropicContent(final.content),
      })

      if (final.stop_reason !== 'tool_use') {
        const text = collectText(final.content)
        const value = parseGenerated(text, schema)
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'end_turn',
          iterations,
          usage: aggregated,
          messages: workingMessages,
          value,
          text,
        } as AgentStreamEvent<T>
        return
      }

      const toolUseBlocks = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      const resultBlocks: ContentBlock[] = []
      for (const block of toolUseBlocks) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        const { content, isError } = await runToolWithRecovery(
          toolMap.get(block.name),
          block.name,
          block.id,
          block.input,
          options,
        )
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: block.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: block.id,
          name: block.name,
          content,
          isError,
        }
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        const text = collectText(final.content)
        const value = parseGenerated(text, schema)
        yield {
          type: 'stop',
          stopReason: 'max_iterations',
          iterations,
          usage: aggregated,
          messages: workingMessages,
          value,
          text,
        } as AgentStreamEvent<T>
        return
      }
    }
  }

  async generate<T>(
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options: ChatOptions = {},
  ): Promise<GenerateResult<T>> {
    const params = this.buildParams(messages, options) as Anthropic.MessageCreateParamsNonStreaming
    params.output_config = {
      ...(params.output_config ?? {}),
      format: { type: 'json_schema', schema: schema.jsonSchema },
    }
    const response = await this.client.messages.create(params, reqOpts(options))
    const text = collectText(response.content)
    const value = parseGenerated(text, schema)
    return {
      value,
      text,
      model: response.model,
      stopReason: response.stop_reason,
      usage: toAnthropicUsage(response.usage),
      raw: response,
    }
  }

  // ─── Param translation ──────────────────────────────────────────────────

  private buildParams(
    messages: readonly Message[],
    options: ChatOptions,
  ): Anthropic.MessageCreateParamsNonStreaming {
    return buildAnthropicMessageParams(messages, options, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
      betas: this.betas,
    })
  }
}
