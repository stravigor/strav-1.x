/**
 * `OpenAIProvider` — implementation of `Provider` backed by the
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
import type { AgentResult } from '../agent_result.ts'
import { BrainError } from '../brain_error.ts'
import type { OpenAIProviderConfig } from '../brain_config.ts'
import type { MCPServer } from '../mcp_server.ts'
import type { AgentGenerateResult } from '../agent_generate_result.ts'
import type { AgentStreamEvent } from '../agent_stream_event.ts'
import { resolveMcpTools, type ResolveMcpToolsOptions } from '../mcp/resolve_mcp_tools.ts'
import { parseGenerated, type OutputSchema } from '../output_schema.ts'
import { recoverOrThrow, runToolWithRecovery } from '../tool_runner.ts'
import type {
  Provider,
  RunWithToolsOptions,
  RunWithToolsOptionsWithSuspend,
} from '../provider.ts'
import type { SuspendedRun } from '../suspended_run.ts'
import type { Tool } from '../tool.ts'
import { ToolExecutionError } from '../tool_execution_error.ts'
import type {
  AudioSource,
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  EmbedOptions,
  EmbedResult,
  GenerateResult,
  ImageBlock,
  Message,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscribeOptions,
  TranscribeResult,
} from '../types.ts'

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

export class OpenAIProvider implements Provider {
  readonly name: string
  // Protected (rather than private) so OpenAI-compatible drivers
  // can subclass — see `DeepSeekProvider`. Apps that want to plug
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
    return this.toChatResult(response)
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
      usage: toUsage(aggregatedUsage),
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
      const params = this.buildParams(workingMessages, options, tools)
      const response = await this.client.chat.completions.create(params, reqOpts(options))
      addUsage(aggregated, response.usage)

      const choice = response.choices[0]
      if (!choice) {
        throw new BrainError('OpenAIProvider: response had no choices.')
      }
      const assistantMessage = choice.message

      // Append assistant turn to working messages so we send it back
      // verbatim on the next round-trip.
      workingMessages.push({
        role: 'assistant',
        content: fromOpenAIAssistantMessage(assistantMessage),
      })

      const toolCalls = assistantMessage.tool_calls ?? []
      if (toolCalls.length === 0 || choice.finish_reason !== 'tool_calls') {
        return {
          text: assistantMessage.content ?? '',
          messages: workingMessages,
          iterations,
          stopReason: choice.finish_reason ?? 'stop',
          usage: aggregated,
        }
      }

      const resultBlocks: ContentBlock[] = []
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i]!
        if (call.type !== 'function') continue
        let parsedInput: unknown
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch (err) {
          parseFailed = recoverOrThrow(
            new ToolExecutionError(
              call.function.name,
              call.id,
              new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
            ),
            options,
          )
        }
        if (options.shouldSuspend && !parseFailed) {
          const frameworkCall: ToolUseBlock = {
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: (parsedInput ?? {}) as Record<string, unknown>,
          }
          if (await options.shouldSuspend(frameworkCall, options.context)) {
            const pending: ToolUseBlock[] = []
            for (let j = i; j < toolCalls.length; j++) {
              const c = toolCalls[j]!
              if (c.type !== 'function') continue
              let pInput: unknown = {}
              try {
                pInput = c.function.arguments ? JSON.parse(c.function.arguments) : {}
              } catch {
                pInput = c.function.arguments ?? {}
              }
              pending.push({
                type: 'tool_use',
                id: c.id,
                name: c.function.name,
                input: pInput as Record<string, unknown>,
              })
            }
            return {
              status: 'suspended',
              pendingToolCalls: pending,
              state: { messages: workingMessages, iterations, usage: aggregated },
            }
          }
        }
        const { content, isError } = parseFailed
          ?? (await runToolWithRecovery(
            toolMap.get(call.function.name),
            call.function.name,
            call.id,
            parsedInput,
            options,
          ))
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        return {
          text: assistantMessage.content ?? '',
          messages: workingMessages,
          iterations,
          stopReason: 'max_iterations',
          usage: aggregated,
        }
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
    const workingMessages: Message[] = [...messages]
    const aggregated: ChatUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    let iterations = 0

    while (true) {
      const params = this.buildParams(workingMessages, options, tools)
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
      addUsage(aggregated, response.usage)

      const choice = response.choices[0]
      if (!choice) {
        throw new BrainError('OpenAIProvider: response had no choices.')
      }
      const assistantMessage = choice.message
      workingMessages.push({
        role: 'assistant',
        content: fromOpenAIAssistantMessage(assistantMessage),
      })

      const toolCalls = assistantMessage.tool_calls ?? []
      if (toolCalls.length === 0 || choice.finish_reason !== 'tool_calls') {
        const text = assistantMessage.content ?? ''
        return {
          value: parseGenerated(text, schema),
          text,
          messages: workingMessages,
          iterations,
          stopReason: choice.finish_reason ?? 'stop',
          usage: aggregated,
        }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        if (call.type !== 'function') continue
        let parsedInput: unknown
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch (err) {
          parseFailed = recoverOrThrow(
            new ToolExecutionError(
              call.function.name,
              call.id,
              new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
            ),
            options,
          )
        }
        const { content, isError } = parseFailed
          ?? (await runToolWithRecovery(
            toolMap.get(call.function.name),
            call.function.name,
            call.id,
            parsedInput,
            options,
          ))
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        const text = assistantMessage.content ?? ''
        return {
          value: parseGenerated(text, schema),
          text,
          messages: workingMessages,
          iterations,
          stopReason: 'max_iterations',
          usage: aggregated,
        }
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
      const toolCallsByIndex: Map<
        number,
        { id?: string; name?: string; args: string; started: boolean }
      > = new Map()
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

      addUsage(aggregated, lastUsage)
      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      // Materialize the assistant turn the same way runWithTools does.
      const assistantBlocks: ContentBlock[] = []
      if (textBuf.length > 0) assistantBlocks.push({ type: 'text', text: textBuf })
      const orderedCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v)
      for (const call of orderedCalls) {
        if (!call.id || !call.name) continue
        let parsedInput: unknown = {}
        try {
          parsedInput = call.args ? JSON.parse(call.args) : {}
        } catch {
          parsedInput = call.args
        }
        assistantBlocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parsedInput,
        } satisfies ToolUseBlock)
      }
      const assistantContent: string | ContentBlock[] =
        assistantBlocks.length === 1 && assistantBlocks[0]?.type === 'text'
          ? assistantBlocks[0].text
          : assistantBlocks
      workingMessages.push({ role: 'assistant', content: assistantContent })

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
        let parsedInput: unknown
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.args ? JSON.parse(call.args) : {}
        } catch (err) {
          parseFailed = recoverOrThrow(
            new ToolExecutionError(
              call.name,
              call.id,
              new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
            ),
            options,
          )
          parsedInput = call.args
        }
        yield { type: 'tool_use', id: call.id, name: call.name, input: parsedInput }
        const { content, isError } = parseFailed
          ?? (await runToolWithRecovery(
            toolMap.get(call.name),
            call.name,
            call.id,
            parsedInput,
            options,
          ))
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
      const toolCallsByIndex: Map<
        number,
        { id?: string; name?: string; args: string; started: boolean }
      > = new Map()
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

      addUsage(aggregated, lastUsage)
      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      const assistantBlocks: ContentBlock[] = []
      if (textBuf.length > 0) assistantBlocks.push({ type: 'text', text: textBuf })
      const orderedCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v)
      for (const call of orderedCalls) {
        if (!call.id || !call.name) continue
        let parsedInput: unknown = {}
        try {
          parsedInput = call.args ? JSON.parse(call.args) : {}
        } catch {
          parsedInput = call.args
        }
        assistantBlocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parsedInput,
        } satisfies ToolUseBlock)
      }
      const assistantContent: string | ContentBlock[] =
        assistantBlocks.length === 1 && assistantBlocks[0]?.type === 'text'
          ? assistantBlocks[0].text
          : assistantBlocks
      workingMessages.push({ role: 'assistant', content: assistantContent })

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
        let parsedInput: unknown
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.args ? JSON.parse(call.args) : {}
        } catch (err) {
          parseFailed = recoverOrThrow(
            new ToolExecutionError(
              call.name,
              call.id,
              new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
            ),
            options,
          )
          parsedInput = call.args
        }
        yield { type: 'tool_use', id: call.id, name: call.name, input: parsedInput }
        const { content, isError } = parseFailed
          ?? (await runToolWithRecovery(
            toolMap.get(call.name),
            call.name,
            call.id,
            parsedInput,
            options,
          ))
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
      usage: toUsage(response.usage),
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

  protected buildParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    if (options.serverTools && options.serverTools.length > 0) {
      throw new BrainError(
        "OpenAIProvider: server tools (web_search / code_execution / web_fetch / url_context) are not supported on OpenAI's chat completions API. OpenAI's server tools live on the Responses API (separate provider slice). Run them as framework-local tools, route to Anthropic / Gemini, or wait for the OpenAIResponsesProvider slice.",
        { context: { provider: 'openai' } },
      )
    }
    const model = options.model ?? this.defaultModel
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      max_completion_tokens: options.maxTokens ?? this.defaultMaxTokens,
      messages: this.toMessages(options.system, messages),
    }

    if (tools.length > 0) {
      params.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }))
    }

    // Reasoning controls — only emitted when explicitly set so
    // non-reasoning models don't get rejected.
    if (options.effort !== undefined) {
      params.reasoning_effort = options.effort as OpenAI.ReasoningEffort
    } else if (options.thinking === 'adaptive') {
      params.reasoning_effort = 'medium' as OpenAI.ReasoningEffort
    } else if (options.thinking === 'disabled') {
      params.reasoning_effort = 'minimal' as OpenAI.ReasoningEffort
    }

    // `cache` is a no-op on OpenAI — prompt caching is automatic.
    // We accept the flag silently so apps that target both providers
    // with the same options object don't have to special-case.

    return params
  }

  private toMessages(
    system: SystemPrompt | undefined,
    messages: readonly Message[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
    const systemText = systemPromptText(system)
    if (systemText.length > 0) {
      out.push({ role: 'system', content: systemText })
    }
    for (const message of messages) {
      // User-role messages with tool results in their content fan
      // out into one `tool`-role message per result — OpenAI's
      // contract is "one tool_call_id per tool message," not a
      // single user message carrying multiple results.
      if (
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((b) => b.type === 'tool_result')
      ) {
        const remainingText: string[] = []
        for (const block of message.content) {
          if (block.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: block.toolUseId,
              content: typeof block.content === 'string'
                ? block.content
                : block.content.map((t) => t.text).join(''),
            })
          } else if (block.type === 'text') {
            remainingText.push(block.text)
          }
        }
        if (remainingText.length > 0) {
          out.push({ role: 'user', content: remainingText.join('') })
        }
        continue
      }
      out.push(toOpenAIMessage(message))
    }
    return out
  }

  private toChatResult(
    response: OpenAI.Chat.ChatCompletion,
  ): ChatResult<OpenAI.Chat.ChatCompletion> {
    const choice = response.choices[0]
    return {
      text: choice?.message?.content ?? '',
      model: response.model,
      stopReason: choice?.finish_reason ?? null,
      usage: toUsage(response.usage),
      raw: response,
    }
  }
}

// ─── Shape converters ─────────────────────────────────────────────────────

/** Build the request-options bag forwarded to the SDK. Only `signal` for now. */
function reqOpts(options: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return options.signal !== undefined ? { signal: options.signal } : undefined
}

/**
 * Materialize an `AudioSource` as a `File` the OpenAI SDK's
 * `Uploadable` shape accepts. Base64 → in-memory File; URL →
 * fetch + wrap. The SDK wants a filename; we synthesize one
 * since `AudioSource` doesn't carry one. The extension lets the
 * SDK pick the right content-type for the multipart upload.
 */
async function audioSourceToFile(audio: AudioSource): Promise<File> {
  if (audio.type === 'base64') {
    const bytes = Buffer.from(audio.data, 'base64')
    const ext = extFromMime(audio.mediaType)
    return new File([bytes], `audio.${ext}`, { type: audio.mediaType })
  }
  const response = await fetch(audio.url)
  if (!response.ok) {
    throw new BrainError(
      `OpenAIProvider.transcribe: failed to fetch audio at ${audio.url}: ${response.status} ${response.statusText}.`,
      { context: { url: audio.url, status: response.status } },
    )
  }
  const buf = await response.arrayBuffer()
  const mime = response.headers.get('content-type') ?? 'audio/mpeg'
  return new File([buf], `audio.${extFromMime(mime)}`, { type: mime })
}

function extFromMime(mime: string): string {
  // Strip parameters (`audio/mpeg; codecs=...` → `audio/mpeg`).
  const m = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (m === 'audio/mp3' || m === 'audio/mpeg' || m === 'audio/mpga') return 'mp3'
  if (m === 'audio/wav' || m === 'audio/x-wav') return 'wav'
  if (m === 'audio/ogg') return 'ogg'
  if (m === 'audio/flac') return 'flac'
  if (m === 'audio/webm') return 'webm'
  if (m === 'audio/aac' || m === 'audio/x-aac' || m === 'audio/mp4' || m === 'audio/m4a') return 'm4a'
  return 'mp3'
}

/** Throw a DOMException-shaped abort error if the signal has fired. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

function systemPromptText(system: SystemPrompt | undefined): string {
  if (system === undefined) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map((b) => b.text).join('\n')
  return system.text
}

function toOpenAIMessage(message: Message): OpenAI.Chat.ChatCompletionMessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content } as OpenAI.Chat.ChatCompletionMessageParam
  }

  // Assistant turns may contain text + tool_use blocks; we need to
  // split tool_use blocks into the `tool_calls` field and put the
  // remaining text into `content`.
  if (message.role === 'assistant') {
    const text = message.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    const param: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: 'assistant' }
    if (text.length > 0) param.content = text
    if (toolUses.length > 0) {
      param.tool_calls = toolUses.map((b) => ({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }))
    }
    return param
  }

  // Document / audio aren't supported by OpenAI's chat completions
  // API. Throw with vendor-specific guidance so apps don't waste a
  // 400 trying to send a PDF.
  for (const block of message.content) {
    if (block.type === 'document') {
      throw new BrainError(
        "OpenAIProvider: document blocks are not supported on OpenAI's chat completions API. For PDFs, split the document to images (one per page) and send them as ImageBlocks on a vision-capable model (gpt-5 / gpt-4o family); or route document workloads to Anthropic / Gemini, which accept PDF blocks natively.",
        { context: { provider: 'openai' } },
      )
    }
    if (block.type === 'audio') {
      throw new BrainError(
        "OpenAIProvider: audio blocks are not supported on OpenAI's chat completions API. Transcribe audio upstream via OpenAI's Whisper / gpt-4o-transcribe and send the resulting text; or route audio workloads to Gemini, which accepts audio blocks natively.",
        { context: { provider: 'openai' } },
      )
    }
  }

  // User-role multi-block content. If any image blocks are present,
  // emit OpenAI's multi-part content array (text + image_url
  // entries). Otherwise flatten text — keeps simple text messages
  // cleanly typed as strings. MCP blocks (read-only,
  // Anthropic-specific) are silently dropped.
  const images = message.content.filter((b): b is ImageBlock => b.type === 'image')
  if (images.length > 0) {
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const url =
          block.source.type === 'base64'
            ? `data:${block.source.mediaType};base64,${block.source.data}`
            : block.source.url
        parts.push({ type: 'image_url', image_url: { url } })
      }
      // tool_result / tool_use / mcp blocks dropped from user content
      // (they're handled elsewhere or aren't valid on user turns).
    }
    return { role: 'user', content: parts }
  }
  const text = message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { role: 'user', content: text }
}

function fromOpenAIAssistantMessage(
  msg: OpenAI.Chat.ChatCompletionMessage,
): string | ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (msg.content) blocks.push({ type: 'text', text: msg.content })
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue
      let parsedInput: unknown = {}
      try {
        parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        parsedInput = call.function.arguments ?? {}
      }
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parsedInput,
      } satisfies ToolUseBlock)
    }
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text
  return blocks
}

function toUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
  }
}

function addUsage(acc: ChatUsage, u: OpenAI.CompletionUsage | undefined): void {
  if (!u) return
  acc.inputTokens += u.prompt_tokens
  acc.outputTokens += u.completion_tokens
  acc.cacheReadTokens += u.prompt_tokens_details?.cached_tokens ?? 0
}
