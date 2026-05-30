/**
 * `OpenAIBrainDriver` — implementation of `Provider` backed by the
 * official `openai` SDK (chat completions API).
 *
 * Maps framework shapes to OpenAI's wire format:
 *
 *   - `system` becomes the first message with `role: 'system'`.
 *     (OpenAI doesn't have a separate system field on chat
 *     completions; o1/o3 reasoning models accept `developer` as
 *     a synonym but `system` still works.)
 *
 *   - `Message` with string content → `{role, content: string}`.
 *     `Message` with `ContentBlock[]`: text blocks concatenate into
 *     a single content string; `ToolUseBlock`s on assistant turns
 *     translate to `tool_calls`; `ToolResultBlock`s in user turns
 *     each become their own `{role: 'tool', tool_call_id, content}`
 *     message (OpenAI requires this layout, not a single user turn
 *     with mixed content like Anthropic's).
 *
 *   - `Tool[]` → `[{type: 'function', function: {name, description,
 *     parameters: tool.inputSchema}}]`. OpenAI wraps every tool in
 *     a `function` namespace where Anthropic uses flat tool
 *     definitions.
 *
 *   - `MCPServer[]` → resolved via the local MCP client
 *     (`@strav/brain/mcp`). Each server is dialed, its tools are
 *     discovered, and they're merged with locally-defined tools.
 *     The agentic loop then treats them uniformly. Tool names are
 *     namespaced `<server>__<tool>` to avoid collisions. Transports
 *     are closed in a `finally` once the loop exits.
 *
 *   - `cache: true` is a no-op. OpenAI auto-caches; there's no
 *     per-block cache_control to set. The framework flag is
 *     accepted (so config that targets both providers still
 *     works) but doesn't emit anything to the wire.
 *
 *   - `thinking: 'adaptive'` maps to `reasoning_effort: 'medium'`
 *     on reasoning models (o1, o3, o5, etc.); `'disabled'` maps
 *     to `reasoning_effort: 'minimal'`. Non-reasoning models
 *     silently ignore the field.
 *
 *   - `effort` (when set) maps directly to `reasoning_effort`
 *     when supported by the model.
 *
 *   - `countTokens` is NOT implemented — OpenAI has no dedicated
 *     count endpoint. `BrainManager.countTokens` returns `null`
 *     when the configured provider doesn't expose the method.
 */

import OpenAI from 'openai'
import type { AgentResult } from '../../agent_result.ts'
import { BrainError } from '../../brain_error.ts'
import type { OpenAIProviderConfig } from '../../brain_config.ts'
import type { MCPServer } from '../../mcp_server.ts'
import type { AgentGenerateResult } from '../../agent_generate_result.ts'
import type { AgentStreamEvent } from '../../agent_stream_event.ts'
import { resolveMcpTools, type ResolveMcpToolsOptions } from '../../mcp/resolve_mcp_tools.ts'
import { parseGenerated, type OutputSchema } from '../../output_schema.ts'
import type {
  BrainDriver,
  RunWithToolsOptions,
  RunWithToolsOptionsWithSuspend,
} from '../../brain_driver.ts'
import type { SuspendedRun } from '../../suspended_run.ts'
import type { Tool } from '../../tool.ts'
import type {
  AudioSource,
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  EmbedOptions,
  EmbedResult,
  GenerateResult,
  Message,
  StreamEvent,
  ToolResultBlock,
  ToolUseBlock,
  TranscribeOptions,
  TranscribeResult,
} from '../../types.ts'
import {
  audioSourceToFile,
  checkAborted,
  reqOpts,
} from './openai_helpers.ts'
import {
  buildOpenAIChatParams,
  toOpenAIMessages,
} from './openai_message_builder.ts'
import {
  addOpenAIUsage,
  toOpenAIChatResult,
  toOpenAIUsage,
} from './openai_response_mapper.ts'
import {
  assistantTurnFromStream,
  executeToolCall,
  orderStreamedCalls,
  parseToolCallArgs,
  type StreamedCallEntry,
} from './openai_tool_dispatch.ts'
import {
  createNonStreamLoopState,
  runOpenAINonStreamIteration,
} from './openai_tool_loop.ts'

const DEFAULT_OPENAI_MODEL = 'gpt-5'
const DEFAULT_OPENAI_EMBED_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_TRANSCRIBE_MODEL = 'whisper-1'

export interface OpenAIProviderOptions {
  client?: OpenAI
  /**
   * Internal seam — tests inject a stub MCP client factory so MCP
   * tool resolution doesn't dial the network. Real apps leave it
   * unset; the provider uses the default `MCPClient`.
   */
  mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
  /**
   * Optional MCP connection pool. When set, every `runWithTools`
   * call (and its schema / streaming variants) borrows MCP clients
   * from the pool instead of constructing fresh ones — and the
   * per-call cleanup becomes a no-op so transports survive across
   * calls. Apps construct one pool at boot and pass it to every
   * provider that needs local MCP; pool ownership stays on the app
   * via `pool.close()` at shutdown.
   */
  mcpPool?: ResolveMcpToolsOptions['pool']
}

export class OpenAIBrainDriver implements BrainDriver {
  readonly name: string
  // Protected (rather than private) so OpenAI-compatible drivers
  // can subclass — see `DeepSeekBrainDriver`. Apps that want to plug
  // in Groq / Together / Fireworks follow the same pattern: extend,
  // override the constructor's base URL + default model, optionally
  // override `buildParams` to suppress fields the upstream API
  // doesn't accept.
  protected readonly client: OpenAI
  protected readonly defaultModel: string
  protected readonly defaultMaxTokens: number
  protected readonly defaultEmbedModel: string
  protected readonly defaultTranscribeModel: string
  protected readonly mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
  protected readonly mcpPool?: ResolveMcpToolsOptions['pool']

  constructor(
    name: string,
    config: OpenAIProviderConfig,
    options: OpenAIProviderOptions = {},
  ) {
    this.name = name
    this.defaultModel = config.defaultModel ?? DEFAULT_OPENAI_MODEL
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096
    this.defaultEmbedModel = config.defaultEmbedModel ?? DEFAULT_OPENAI_EMBED_MODEL
    this.defaultTranscribeModel = config.defaultTranscribeModel ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL
    this.mcpClientFactory = options.mcpClientFactory
    this.mcpPool = options.mcpPool
    this.client =
      options.client ??
      new OpenAI({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
        ...(config.organization !== undefined ? { organization: config.organization } : {}),
      })
  }

  async chat(messages: readonly Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const params = this.buildParams(messages, options, [])
    const response = await this.client.chat.completions.create(params, reqOpts(options))
    return toOpenAIChatResult(response)
  }

  async *stream(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      ...this.buildParams(messages, options, []),
      stream: true,
      stream_options: { include_usage: true },
    }
    const stream = await this.client.chat.completions.create(params, reqOpts(options))
    let aggregatedUsage: OpenAI.CompletionUsage | undefined
    let finishReason: string | null = null
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (typeof delta === 'string' && delta.length > 0) {
        yield { type: 'text', delta }
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason
      }
      if (chunk.usage) aggregatedUsage = chunk.usage
    }
    yield {
      type: 'stop',
      stopReason: finishReason,
      usage: toOpenAIUsage(aggregatedUsage),
    }
  }

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
    const resolved = await this.resolveMcp(options.mcpServers ?? [])
    try {
      return await this._runLoop(messages, [...tools, ...resolved.tools], options)
    } finally {
      await resolved.close()
    }
  }

  private async _runLoop(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions,
  ): Promise<AgentResult | SuspendedRun> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const state = createNonStreamLoopState(messages)
    const buildParams = (msgs: readonly Message[]) => this.buildParams(msgs, options, tools)

    while (true) {
      const outcome = await runOpenAINonStreamIteration({
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
    const resolved = await this.resolveMcp(options.mcpServers ?? [])
    try {
      return await this._runLoopWithSchema([...tools, ...resolved.tools], messages, schema, options)
    } finally {
      await resolved.close()
    }
  }

  private async _runLoopWithSchema<T>(
    tools: readonly Tool[],
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const state = createNonStreamLoopState(messages)
    const buildParams = (msgs: readonly Message[]) => {
      const params = this.buildParams(msgs, options, tools)
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: schema.name,
          ...(schema.description !== undefined ? { description: schema.description } : {}),
          schema: schema.jsonSchema,
          strict: true,
        },
      }
      return params
    }

    while (true) {
      const outcome = await runOpenAINonStreamIteration({
        state,
        toolMap,
        maxIterations,
        client: this.client,
        buildParams,
        options,
        // Schema variant doesn't support suspension — the manager
        // throws BrainError before reaching the loop when shouldSuspend
        // is set on `runWithToolsAndSchema`. See `brain_driver.ts`.
        suspendCheck: undefined,
      })
      if (outcome.kind === 'continue') continue
      if (outcome.kind === 'suspended') {
        // Unreachable: suspendCheck is undefined so 'suspended' can't
        // be produced. Defensive throw makes the assumption explicit.
        throw new BrainError(
          'OpenAIBrainDriver: runWithToolsAndSchema received a suspension outcome but does not support it.',
        )
      }
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
    const resolved = await this.resolveMcp(options.mcpServers ?? [])
    try {
      yield* this._streamLoop(messages, [...tools, ...resolved.tools], options)
    } finally {
      await resolved.close()
    }
  }

  private async *_streamLoop(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions,
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

    while (true) {
      checkAborted(options.signal)
      yield { type: 'iteration_start', iteration: iterations }

      const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        ...this.buildParams(workingMessages, options, tools),
        stream: true,
        stream_options: { include_usage: true },
      }
      const stream = await this.client.chat.completions.create(params, reqOpts(options))

      let textBuf = ''
      // Tracks: per index, the running entry; and whether
      // `tool_use_start` has already been emitted (we emit once the
      // first chunk brings the id + name).
      const toolCallsByIndex: Map<number, StreamedCallEntry> = new Map()
      let finishReason: string | null = null
      let lastUsage: OpenAI.CompletionUsage | undefined

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        const delta = choice?.delta
        if (delta?.content && typeof delta.content === 'string' && delta.content.length > 0) {
          textBuf += delta.content
          yield { type: 'text', delta: delta.content }
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const entry = toolCallsByIndex.get(tc.index) ?? { args: '', started: false }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            toolCallsByIndex.set(tc.index, entry)
            // Emit `tool_use_start` once id+name are both known.
            // OpenAI typically delivers them in the same first
            // chunk for a given tool call.
            if (!entry.started && entry.id !== undefined && entry.name !== undefined) {
              entry.started = true
              yield { type: 'tool_use_start', id: entry.id, name: entry.name }
            }
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments
              // Emit a delta only after start has fired — apps relying
              // on an id wouldn't have one until then.
              if (entry.started && entry.id !== undefined) {
                yield {
                  type: 'tool_use_delta',
                  id: entry.id,
                  argsDelta: tc.function.arguments,
                }
              }
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) lastUsage = chunk.usage
      }

      addOpenAIUsage(aggregated, lastUsage)
      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      const orderedCalls = orderStreamedCalls(toolCallsByIndex)
      workingMessages.push({
        role: 'assistant',
        content: assistantTurnFromStream(textBuf, orderedCalls),
      })

      if (finishReason !== 'tool_calls' || orderedCalls.length === 0) {
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'stop',
          iterations,
          usage: aggregated,
          messages: workingMessages,
        }
        return
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of orderedCalls) {
        if (!call.id || !call.name) continue
        const { parsedInput, parseFailed } = parseToolCallArgs(
          call.name,
          call.id,
          call.args,
          options,
        )
        yield { type: 'tool_use', id: call.id, name: call.name, input: parsedInput }
        const { content, isError } = await executeToolCall(
          call.name,
          call.id,
          parsedInput,
          parseFailed,
          toolMap,
          options,
        )
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
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
    const resolved = await this.resolveMcp(options.mcpServers ?? [])
    try {
      yield* this._streamLoopWithSchema(
        [...tools, ...resolved.tools],
        messages,
        schema,
        options,
      )
    } finally {
      await resolved.close()
    }
  }

  private async *_streamLoopWithSchema<T>(
    tools: readonly Tool[],
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions,
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

    while (true) {
      checkAborted(options.signal)
      yield { type: 'iteration_start', iteration: iterations }

      const baseParams = this.buildParams(workingMessages, options, tools)
      baseParams.response_format = {
        type: 'json_schema',
        json_schema: {
          name: schema.name,
          ...(schema.description !== undefined ? { description: schema.description } : {}),
          schema: schema.jsonSchema,
          strict: true,
        },
      }
      const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        ...baseParams,
        stream: true,
        stream_options: { include_usage: true },
      }
      const stream = await this.client.chat.completions.create(params, reqOpts(options))

      let textBuf = ''
      // Tracks: per index, the running entry; and whether
      // `tool_use_start` has already been emitted (we emit once the
      // first chunk brings the id + name).
      const toolCallsByIndex: Map<number, StreamedCallEntry> = new Map()
      let finishReason: string | null = null
      let lastUsage: OpenAI.CompletionUsage | undefined

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        const delta = choice?.delta
        if (delta?.content && typeof delta.content === 'string' && delta.content.length > 0) {
          textBuf += delta.content
          yield { type: 'text', delta: delta.content }
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const entry = toolCallsByIndex.get(tc.index) ?? { args: '', started: false }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            toolCallsByIndex.set(tc.index, entry)
            // Emit `tool_use_start` once id+name are both known.
            // OpenAI typically delivers them in the same first
            // chunk for a given tool call.
            if (!entry.started && entry.id !== undefined && entry.name !== undefined) {
              entry.started = true
              yield { type: 'tool_use_start', id: entry.id, name: entry.name }
            }
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments
              // Emit a delta only after start has fired — apps relying
              // on an id wouldn't have one until then.
              if (entry.started && entry.id !== undefined) {
                yield {
                  type: 'tool_use_delta',
                  id: entry.id,
                  argsDelta: tc.function.arguments,
                }
              }
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) lastUsage = chunk.usage
      }

      addOpenAIUsage(aggregated, lastUsage)
      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      const orderedCalls = orderStreamedCalls(toolCallsByIndex)
      workingMessages.push({
        role: 'assistant',
        content: assistantTurnFromStream(textBuf, orderedCalls),
      })

      if (finishReason !== 'tool_calls' || orderedCalls.length === 0) {
        const text = textBuf
        const value = parseGenerated(text, schema)
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'stop',
          iterations,
          usage: aggregated,
          messages: workingMessages,
          value,
          text,
        } as AgentStreamEvent<T>
        return
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of orderedCalls) {
        if (!call.id || !call.name) continue
        const { parsedInput, parseFailed } = parseToolCallArgs(
          call.name,
          call.id,
          call.args,
          options,
        )
        yield { type: 'tool_use', id: call.id, name: call.name, input: parsedInput }
        const { content, isError } = await executeToolCall(
          call.name,
          call.id,
          parsedInput,
          parseFailed,
          toolMap,
          options,
        )
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          content,
          isError,
        }
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        const text = textBuf
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

  async transcribe(
    audio: AudioSource,
    options: TranscribeOptions = {},
  ): Promise<TranscribeResult<OpenAI.Audio.TranscriptionCreateResponse>> {
    const model = options.model ?? this.defaultTranscribeModel
    const file = await audioSourceToFile(audio)
    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file,
      model,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    }
    const response = await this.client.audio.transcriptions.create(
      params,
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
    // Whisper-1 returns { text, language?, duration? } when
    // response_format is 'verbose_json'; we default to the SDK
    // default (`json`) which only surfaces `text`. Apps that
    // want language / duration from Whisper set
    // `response_format: 'verbose_json'` via a raw SDK call;
    // we can extend the option set when an app asks.
    const text = 'text' in response && typeof response.text === 'string' ? response.text : ''
    const result: TranscribeResult<OpenAI.Audio.TranscriptionCreateResponse> = {
      text,
      model,
      raw: response,
    }
    if ('language' in response && typeof response.language === 'string') {
      result.language = response.language
    }
    if ('duration' in response && typeof response.duration === 'number') {
      result.duration = response.duration
    }
    return result
  }

  async embed(
    texts: readonly string[],
    options: EmbedOptions = {},
  ): Promise<EmbedResult<OpenAI.CreateEmbeddingResponse>> {
    const model = options.model ?? this.defaultEmbedModel
    const params: OpenAI.EmbeddingCreateParams = {
      model,
      input: texts as string[],
      ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
    }
    const response = await this.client.embeddings.create(
      params,
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
    return {
      embeddings: response.data.map((d) => d.embedding),
      model: response.model,
      usage: { inputTokens: response.usage?.prompt_tokens ?? 0 },
      raw: response,
    }
  }

  async generate<T>(
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options: ChatOptions = {},
  ): Promise<GenerateResult<T>> {
    const params = this.buildParams(messages, options, [])
    params.response_format = {
      type: 'json_schema',
      json_schema: {
        name: schema.name,
        ...(schema.description !== undefined ? { description: schema.description } : {}),
        schema: schema.jsonSchema,
        strict: true,
      },
    }
    const response = await this.client.chat.completions.create(params, reqOpts(options))
    const choice = response.choices[0]
    const text = choice?.message?.content ?? ''
    const value = parseGenerated(text, schema)
    return {
      value,
      text,
      model: response.model,
      stopReason: choice?.finish_reason ?? null,
      usage: toOpenAIUsage(response.usage),
      raw: response,
    }
  }

  /**
   * Single resolve-MCP entry point used by every tool-loop variant.
   * Threads both the test-only `clientFactory` and the optional
   * `mcpPool` through. Caller invokes `resolved.close()` in
   * `finally`; that's a no-op when the pool owns the lifetime.
   */
  protected resolveMcp(servers: readonly MCPServer[]): Promise<{
    tools: Tool[]
    close: () => Promise<void>
  }> {
    if (servers.length === 0) {
      return Promise.resolve({ tools: [], close: async () => {} })
    }
    return resolveMcpTools(servers, {
      ...(this.mcpClientFactory ? { clientFactory: this.mcpClientFactory } : {}),
      ...(this.mcpPool ? { pool: this.mcpPool } : {}),
    })
  }

  // ─── Param translation ──────────────────────────────────────────────────

  /**
   * Thin wrapper around `buildOpenAIChatParams` so `OpenAICompatBrainDriver`
   * subclasses can still override the request shape via `super.buildParams(...)`
   * (e.g. strip `reasoning_effort` for endpoints that reject it). Pure
   * translation lives in `openai_message_builder.ts`.
   */
  protected buildParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    return buildOpenAIChatParams(messages, options, tools, {
      defaultModel: this.defaultModel,
      defaultMaxTokens: this.defaultMaxTokens,
    })
  }
}
