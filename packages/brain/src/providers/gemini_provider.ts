/**
 * `GeminiProvider` — implementation of `Provider` backed by the
 * official `@google/genai` SDK (Gemini Developer API / Vertex AI).
 *
 * Maps framework shapes to Gemini's wire format:
 *
 *   - `system` → `config.systemInstruction` (string-joined when
 *     multi-block). Cache flags on the system prompt are ignored —
 *     Gemini's prompt caching uses an explicit Caches API rather
 *     than per-block flags, so `cache: true` becomes a no-op
 *     consistent with the OpenAI provider.
 *
 *   - `Message[]` → `Content[]`. Framework `role: 'user' | 'assistant'`
 *     maps to Gemini's `role: 'user' | 'model'`. String content
 *     becomes a single `{text}` part; `ContentBlock[]` content fans
 *     out:
 *       - `TextBlock`         → `{text}`
 *       - `ToolUseBlock`      → `{functionCall: {id, name, args}}`
 *       - `ToolResultBlock`   → `{functionResponse: {id, name,
 *                                  response: {result | error}}}`
 *       - `MCP*` blocks       → silently dropped (Anthropic-only).
 *
 *   - `Tool[]` → `[{functionDeclarations: [{name, description,
 *     parametersJsonSchema: inputSchema}]}]`. We use
 *     `parametersJsonSchema` (not `parameters`) so JSON-Schema-shaped
 *     tool inputs pass through verbatim without translation to
 *     Gemini's `Schema` form.
 *
 *   - `MCPServer[]` → resolved via the local MCP client
 *     (`@strav/brain/mcp`). Discovered tools are namespaced
 *     `<server>__<tool>` and merged with caller-supplied tools.
 *     Transports are closed in a `finally` once the loop exits.
 *     Gemini has no first-party server-side MCP equivalent to
 *     Anthropic's connector.
 *
 *   - `thinking: 'adaptive'` → `thinkingConfig: { thinkingBudget: -1 }`
 *     (auto). `'disabled'` → `thinkingConfig: { thinkingBudget: 0 }`.
 *     Explicit `effort` (`low`/`medium`/`high`/`xhigh`/`max`) maps to
 *     `thinkingConfig.thinkingLevel`. Non-thinking models ignore the
 *     field upstream — we always emit, the SDK rejects only for
 *     models that don't support it.
 *
 *   - `cache: true` → no-op. Gemini's prompt cache lives behind the
 *     `Caches` API; same accepted-silently behavior as OpenAI.
 *
 *   - `countTokens` IS implemented — `ai.models.countTokens` exists
 *     and is cheap. Returns `totalTokens`.
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from '@google/genai'
import type { AgentResult } from '../agent_result.ts'
import { BrainError } from '../brain_error.ts'
import type { GeminiProviderConfig } from '../brain_config.ts'
import type { MCPServer } from '../mcp_server.ts'
import type { AgentGenerateResult } from '../agent_generate_result.ts'
import type { AgentStreamEvent } from '../agent_stream_event.ts'
import { resolveMcpTools, type ResolveMcpToolsOptions } from '../mcp/resolve_mcp_tools.ts'
import { parseGenerated, type OutputSchema } from '../output_schema.ts'
import type { Provider, RunWithToolsOptions } from '../provider.ts'
import type { Tool } from '../tool.ts'
import { ToolExecutionError } from '../tool_execution_error.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  GenerateResult,
  Message,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.ts'

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

/**
 * The slice of `GoogleGenAI` the provider exercises. Narrowed so
 * tests can inject a stub without satisfying the full SDK surface.
 */
export interface GeminiModelsClient {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>
  generateContentStream(
    params: GenerateContentParameters,
  ): Promise<AsyncIterable<GenerateContentResponse>>
  countTokens(params: { model: string; contents: Content[] }): Promise<{ totalTokens?: number }>
}

export interface GeminiProviderOptions {
  client?: { models: GeminiModelsClient }
  /** Internal seam — tests inject a stub MCP client factory. */
  mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
}

export class GeminiProvider implements Provider {
  readonly name: string
  private readonly models: GeminiModelsClient
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number
  private readonly mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']

  constructor(name: string, config: GeminiProviderConfig, options: GeminiProviderOptions = {}) {
    this.name = name
    this.defaultModel = config.defaultModel ?? DEFAULT_GEMINI_MODEL
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096
    this.mcpClientFactory = options.mcpClientFactory
    if (options.client) {
      this.models = options.client.models
    } else {
      const httpOpts =
        config.baseUrl !== undefined || config.apiVersion !== undefined
          ? {
              ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
              ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
            }
          : undefined
      const sdk = new GoogleGenAI({
        apiKey: config.apiKey,
        ...(httpOpts ? { httpOptions: httpOpts } : {}),
      })
      this.models = sdk.models as unknown as GeminiModelsClient
    }
  }

  async chat(messages: readonly Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const params = this.buildParams(messages, options, [])
    const response = await this.models.generateContent(params)
    return this.toChatResult(response, params.model)
  }

  async *stream(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const params = this.buildParams(messages, options, [])
    const stream = await this.models.generateContentStream(params)
    let finishReason: string | null = null
    let lastUsage: ChatUsage | undefined
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0]
      const text = candidateText(candidate)
      if (text.length > 0) yield { type: 'text', delta: text }
      if (candidate?.finishReason) finishReason = String(candidate.finishReason)
      if (chunk.usageMetadata) lastUsage = toUsage(chunk.usageMetadata)
    }
    yield {
      type: 'stop',
      stopReason: finishReason,
      usage: lastUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    }
  }

  async countTokens(messages: readonly Message[], options: ChatOptions = {}): Promise<number> {
    const contents = this.toContents(messages)
    const model = options.model ?? this.defaultModel
    const response = await this.models.countTokens({ model, contents })
    return response.totalTokens ?? 0
  }

  async runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): Promise<AgentResult> {
    const mcpServers: readonly MCPServer[] = options.mcpServers ?? []
    const resolved =
      mcpServers.length > 0
        ? await resolveMcpTools(mcpServers, {
            ...(this.mcpClientFactory ? { clientFactory: this.mcpClientFactory } : {}),
          })
        : { tools: [] as Tool[], close: async () => {} }
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
  ): Promise<AgentResult> {
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
      const response = await this.models.generateContent(params)
      addUsage(aggregated, response.usageMetadata)

      const candidate = response.candidates?.[0]
      if (!candidate) {
        throw new BrainError('GeminiProvider: response had no candidates.')
      }
      const parts = candidate.content?.parts ?? []
      const assistantContent = fromGeminiParts(parts)
      workingMessages.push({ role: 'assistant', content: assistantContent })

      const toolUses = (Array.isArray(assistantContent) ? assistantContent : []).filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        return {
          text: typeof assistantContent === 'string'
            ? assistantContent
            : candidateText(candidate),
          messages: workingMessages,
          iterations,
          stopReason: candidate.finishReason ? String(candidate.finishReason) : 'stop',
          usage: aggregated,
        }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolUses) {
        const tool = toolMap.get(call.name)
        if (!tool) {
          throw new ToolExecutionError(
            call.name,
            call.id,
            new Error(`Tool "${call.name}" is not registered.`),
          )
        }
        let output: unknown
        try {
          output = await tool.execute(call.input, {
            callId: call.id,
            context: options.context ?? {},
          })
        } catch (cause) {
          throw new ToolExecutionError(call.name, call.id, cause)
        }
        const resultBlock: ToolResultBlock = {
          type: 'tool_result',
          toolUseId: call.id,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        }
        resultBlocks.push(resultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        return {
          text: candidateText(candidate),
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
    const mcpServers: readonly MCPServer[] = options.mcpServers ?? []
    const resolved =
      mcpServers.length > 0
        ? await resolveMcpTools(mcpServers, {
            ...(this.mcpClientFactory ? { clientFactory: this.mcpClientFactory } : {}),
          })
        : { tools: [] as Tool[], close: async () => {} }
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
      params.config = {
        ...(params.config ?? {}),
        responseMimeType: 'application/json',
        responseJsonSchema: schema.jsonSchema,
      }
      const response = await this.models.generateContent(params)
      addUsage(aggregated, response.usageMetadata)

      const candidate = response.candidates?.[0]
      if (!candidate) {
        throw new BrainError('GeminiProvider: response had no candidates.')
      }
      const parts = candidate.content?.parts ?? []
      const assistantContent = fromGeminiParts(parts)
      workingMessages.push({ role: 'assistant', content: assistantContent })

      const toolUses = (Array.isArray(assistantContent) ? assistantContent : []).filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        const text = typeof assistantContent === 'string'
          ? assistantContent
          : candidateText(candidate)
        return {
          value: parseGenerated(text, schema),
          text,
          messages: workingMessages,
          iterations,
          stopReason: candidate.finishReason ? String(candidate.finishReason) : 'stop',
          usage: aggregated,
        }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolUses) {
        const tool = toolMap.get(call.name)
        if (!tool) {
          throw new ToolExecutionError(
            call.name,
            call.id,
            new Error(`Tool "${call.name}" is not registered.`),
          )
        }
        let output: unknown
        try {
          output = await tool.execute(call.input, {
            callId: call.id,
            context: options.context ?? {},
          })
        } catch (cause) {
          throw new ToolExecutionError(call.name, call.id, cause)
        }
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        } satisfies ToolResultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        const text = candidateText(candidate)
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
    const mcpServers: readonly MCPServer[] = options.mcpServers ?? []
    const resolved =
      mcpServers.length > 0
        ? await resolveMcpTools(mcpServers, {
            ...(this.mcpClientFactory ? { clientFactory: this.mcpClientFactory } : {}),
          })
        : { tools: [] as Tool[], close: async () => {} }
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
      yield { type: 'iteration_start', iteration: iterations }

      const params = this.buildParams(workingMessages, options, tools)
      const stream = await this.models.generateContentStream(params)

      const accumulatedParts: Part[] = []
      let finishReason: string | null = null
      let lastUsage: ChatUsage | undefined

      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0]
        const chunkParts = candidate?.content?.parts ?? []
        for (const part of chunkParts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            yield { type: 'text', delta: part.text }
          }
        }
        accumulatedParts.push(...chunkParts)
        if (candidate?.finishReason) finishReason = String(candidate.finishReason)
        if (chunk.usageMetadata) lastUsage = toUsage(chunk.usageMetadata)
      }
      if (lastUsage) {
        aggregated.inputTokens += lastUsage.inputTokens
        aggregated.outputTokens += lastUsage.outputTokens
        aggregated.cacheReadTokens += lastUsage.cacheReadTokens
      }

      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      const assistantContent = fromGeminiParts(accumulatedParts)
      workingMessages.push({ role: 'assistant', content: assistantContent })

      const toolUses = (Array.isArray(assistantContent) ? assistantContent : []).filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
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
      for (const call of toolUses) {
        const tool = toolMap.get(call.name)
        if (!tool) {
          throw new ToolExecutionError(
            call.name,
            call.id,
            new Error(`Tool "${call.name}" is not registered.`),
          )
        }
        yield { type: 'tool_use', id: call.id, name: call.name, input: call.input }
        let output: unknown
        try {
          output = await tool.execute(call.input, {
            callId: call.id,
            context: options.context ?? {},
          })
        } catch (cause) {
          throw new ToolExecutionError(call.name, call.id, cause)
        }
        const content = typeof output === 'string' ? output : JSON.stringify(output)
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          content,
          isError: false,
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
    const mcpServers: readonly MCPServer[] = options.mcpServers ?? []
    const resolved =
      mcpServers.length > 0
        ? await resolveMcpTools(mcpServers, {
            ...(this.mcpClientFactory ? { clientFactory: this.mcpClientFactory } : {}),
          })
        : { tools: [] as Tool[], close: async () => {} }
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
      yield { type: 'iteration_start', iteration: iterations }

      const params = this.buildParams(workingMessages, options, tools)
      params.config = {
        ...(params.config ?? {}),
        responseMimeType: 'application/json',
        responseJsonSchema: schema.jsonSchema,
      }
      const stream = await this.models.generateContentStream(params)

      const accumulatedParts: Part[] = []
      let textBuf = ''
      let finishReason: string | null = null
      let lastUsage: ChatUsage | undefined

      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0]
        const chunkParts = candidate?.content?.parts ?? []
        for (const part of chunkParts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            textBuf += part.text
            yield { type: 'text', delta: part.text }
          }
        }
        accumulatedParts.push(...chunkParts)
        if (candidate?.finishReason) finishReason = String(candidate.finishReason)
        if (chunk.usageMetadata) lastUsage = toUsage(chunk.usageMetadata)
      }
      if (lastUsage) {
        aggregated.inputTokens += lastUsage.inputTokens
        aggregated.outputTokens += lastUsage.outputTokens
        aggregated.cacheReadTokens += lastUsage.cacheReadTokens
      }

      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      const assistantContent = fromGeminiParts(accumulatedParts)
      workingMessages.push({ role: 'assistant', content: assistantContent })

      const toolUses = (Array.isArray(assistantContent) ? assistantContent : []).filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
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
      for (const call of toolUses) {
        const tool = toolMap.get(call.name)
        if (!tool) {
          throw new ToolExecutionError(
            call.name,
            call.id,
            new Error(`Tool "${call.name}" is not registered.`),
          )
        }
        yield { type: 'tool_use', id: call.id, name: call.name, input: call.input }
        let output: unknown
        try {
          output = await tool.execute(call.input, {
            callId: call.id,
            context: options.context ?? {},
          })
        } catch (cause) {
          throw new ToolExecutionError(call.name, call.id, cause)
        }
        const content = typeof output === 'string' ? output : JSON.stringify(output)
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          content,
          isError: false,
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

  async generate<T>(
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options: ChatOptions = {},
  ): Promise<GenerateResult<T>> {
    const params = this.buildParams(messages, options, [])
    params.config = {
      ...(params.config ?? {}),
      responseMimeType: 'application/json',
      responseJsonSchema: schema.jsonSchema,
    }
    const response = await this.models.generateContent(params)
    const candidate = response.candidates?.[0]
    const text = candidateText(candidate)
    const value = parseGenerated(text, schema)
    return {
      value,
      text,
      model: response.modelVersion ?? params.model,
      stopReason: candidate?.finishReason ? String(candidate.finishReason) : null,
      usage: toUsage(response.usageMetadata),
      raw: response,
    }
  }

  // ─── Param translation ──────────────────────────────────────────────────

  private buildParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): GenerateContentParameters {
    const model = options.model ?? this.defaultModel
    const contents = this.toContents(messages)
    const config: GenerateContentConfig = {
      maxOutputTokens: options.maxTokens ?? this.defaultMaxTokens,
    }

    const systemText = systemPromptText(options.system)
    if (systemText.length > 0) {
      config.systemInstruction = systemText
    }

    if (tools.length > 0) {
      const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.inputSchema,
      }))
      config.tools = [{ functionDeclarations }]
    }

    const thinking = buildThinkingConfig(options)
    if (thinking !== undefined) config.thinkingConfig = thinking

    return { model, contents, config }
  }

  private toContents(messages: readonly Message[]): Content[] {
    return messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(m.content),
    }))
  }

  private toChatResult(
    response: GenerateContentResponse,
    requestedModel: string,
  ): ChatResult<GenerateContentResponse> {
    const candidate = response.candidates?.[0]
    return {
      text: candidateText(candidate),
      model: response.modelVersion ?? requestedModel,
      stopReason: candidate?.finishReason ? String(candidate.finishReason) : null,
      usage: toUsage(response.usageMetadata),
      raw: response,
    }
  }
}

// ─── Shape converters ─────────────────────────────────────────────────────

function systemPromptText(system: SystemPrompt | undefined): string {
  if (system === undefined) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map((b) => b.text).join('\n')
  return system.text
}

function toGeminiParts(content: string | ContentBlock[]): Part[] {
  if (typeof content === 'string') return [{ text: content }]
  const parts: Part[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ text: block.text })
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
      })
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : block.content.map((t) => t.text).join('')
      parts.push({
        functionResponse: {
          id: block.toolUseId,
          name: '',
          response: block.isError ? { error: text } : { result: text },
        },
      })
    }
    // MCP blocks (Anthropic-only) silently dropped.
  }
  return parts
}

function fromGeminiParts(parts: readonly Part[]): string | ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      blocks.push({ type: 'text', text: part.text })
    } else if (part.functionCall) {
      const fc = part.functionCall
      blocks.push({
        type: 'tool_use',
        id: fc.id ?? `gemini_${cryptoRandomId()}`,
        name: fc.name ?? '',
        input: fc.args ?? {},
      } satisfies ToolUseBlock)
    }
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text
  return blocks
}

function candidateText(candidate: { content?: { parts?: Part[] } } | undefined): string {
  const parts = candidate?.content?.parts ?? []
  return parts
    .filter((p) => typeof p.text === 'string' && p.text.length > 0)
    .map((p) => p.text as string)
    .join('')
}

function buildThinkingConfig(options: ChatOptions): GenerateContentConfig['thinkingConfig'] {
  if (options.effort !== undefined) {
    const level = effortToThinkingLevel(options.effort)
    return level !== undefined ? { thinkingLevel: level } : { thinkingBudget: -1 }
  }
  if (options.thinking === 'adaptive') return { thinkingBudget: -1 }
  if (options.thinking === 'disabled') return { thinkingBudget: 0 }
  return undefined
}

function effortToThinkingLevel(
  effort: NonNullable<ChatOptions['effort']>,
): ThinkingLevel | undefined {
  switch (effort) {
    case 'low': return ThinkingLevel.LOW
    case 'medium': return ThinkingLevel.MEDIUM
    case 'high':
    case 'xhigh':
    case 'max':
      return ThinkingLevel.HIGH
  }
}

function toUsage(u: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined): ChatUsage {
  return {
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: u?.candidatesTokenCount ?? 0,
    cacheReadTokens: u?.cachedContentTokenCount ?? 0,
    cacheCreationTokens: 0,
  }
}

function addUsage(
  acc: ChatUsage,
  u: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined,
): void {
  if (!u) return
  acc.inputTokens += u.promptTokenCount ?? 0
  acc.outputTokens += u.candidatesTokenCount ?? 0
  acc.cacheReadTokens += u.cachedContentTokenCount ?? 0
}

function cryptoRandomId(): string {
  // Stable, low-entropy fallback for synthesizing tool-use ids when
  // Gemini omits them. Uniqueness within a single response is all the
  // loop requires — the id only travels back paired with its result
  // and never escapes to the caller.
  return Math.random().toString(36).slice(2, 12)
}
