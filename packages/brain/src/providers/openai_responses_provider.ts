/**
 * `OpenAIResponsesProvider` — implementation of `Provider` backed
 * by the `openai` SDK's Responses API
 * (`client.responses.create`).
 *
 * Use when an app needs:
 *   - OpenAI's server-side tools: `web_search`, `code_interpreter`
 *     (via the framework's `ChatOptions.serverTools` union).
 *   - The Responses API's reasoning surfaces (gpt-5 / o-series).
 *
 * For everything else (plain chat, embeddings, transcription,
 * function calling without server tools), the standard
 * `OpenAIProvider` (driver `'openai'`) is simpler. Apps that
 * use both register them as two separate providers and route
 * per-call.
 *
 * Inherits `embed` + `transcribe` from `OpenAIProvider`
 * (embeddings + Whisper live on different endpoints unchanged).
 *
 * V1 coverage:
 *   - `chat` / `stream` via `responses.create` (with `stream: true`
 *     for the streaming variant).
 *   - `runWithTools` / `streamWithTools` — function-calling loop
 *     against the Responses API. Local tools + MCP tools + server
 *     tools all combine.
 *   - `generate` / `runWithToolsAndSchema` /
 *     `streamWithToolsAndSchema` — throw `BrainError` with
 *     "structured output via Responses API is a follow-up slice"
 *     guidance. Apps that need structured output use
 *     `OpenAIProvider` (driver `'openai'`).
 *
 * The Responses API's message shape (`input_items`) is different
 * from chat completions' `messages`, so this is a separate
 * provider class rather than a strategy inside `OpenAIProvider`.
 * Translation lives in this file.
 */

import OpenAI from 'openai'
import type { AgentGenerateResult } from '../agent_generate_result.ts'
import type { AgentResult } from '../agent_result.ts'
import type { AgentStreamEvent } from '../agent_stream_event.ts'
import { BrainError } from '../brain_error.ts'
import type { OpenAIResponsesProviderConfig } from '../brain_config.ts'
import { resolveMcpTools, type ResolveMcpToolsOptions } from '../mcp/resolve_mcp_tools.ts'
import type { MCPServer } from '../mcp_server.ts'
import type { OutputSchema } from '../output_schema.ts'
import type { Provider, RunWithToolsOptions } from '../provider.ts'
import type { Tool } from '../tool.ts'
import { runToolWithRecovery } from '../tool_runner.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  GenerateResult,
  Message,
  ServerTool,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.ts'
import { OpenAIProvider } from './openai_provider.ts'

const DEFAULT_OPENAI_MODEL = 'gpt-5'
const DEFAULT_OPENAI_MAX_TOKENS = 4096

export interface OpenAIResponsesProviderOptions {
  client?: OpenAI
  /** Internal seam — tests inject a stub MCP client factory. */
  mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
}

/** Translation: framework `ServerTool` → Responses API tool entry. */
type ResponsesTool = Record<string, unknown>

export class OpenAIResponsesProvider extends OpenAIProvider implements Provider {
  constructor(
    name: string,
    config: OpenAIResponsesProviderConfig,
    options: OpenAIResponsesProviderOptions = {},
  ) {
    // Reuse OpenAIProvider's constructor for the SDK client + the
    // chat / embed / transcribe model defaults. Inheritance keeps
    // `client`, `defaultEmbedModel`, `defaultTranscribeModel`
    // working unchanged.
    super(
      name,
      {
        driver: 'openai',
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.organization !== undefined ? { organization: config.organization } : {}),
        defaultModel: config.defaultModel ?? DEFAULT_OPENAI_MODEL,
        defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_OPENAI_MAX_TOKENS,
        ...(config.defaultEmbedModel !== undefined
          ? { defaultEmbedModel: config.defaultEmbedModel }
          : {}),
        ...(config.defaultTranscribeModel !== undefined
          ? { defaultTranscribeModel: config.defaultTranscribeModel }
          : {}),
      },
      options,
    )
  }

  // ─── chat / stream ──────────────────────────────────────────────────────

  override async chat(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const params = this.buildResponsesParams(messages, options, [])
    const response = await this.client.responses.create(
      params,
      reqOpts(options),
    )
    return this.toChatResultFromResponse(response, params.model as string)
  }

  override async *stream(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      ...this.buildResponsesParams(messages, options, []),
      stream: true,
    }
    const stream = await this.client.responses.create(params, reqOpts(options))
    let finishReason: string | null = null
    let usage: OpenAI.Responses.ResponseUsage | undefined
    for await (const event of stream) {
      // Text deltas — `output_text.delta` is the streaming chunk
      // for the model's text output.
      if (event.type === 'response.output_text.delta') {
        const delta = (event as { delta: string }).delta
        if (delta && delta.length > 0) yield { type: 'text', delta }
      } else if (event.type === 'response.completed') {
        const completed = (event as { response: OpenAI.Responses.Response }).response
        usage = completed.usage
        // Responses API doesn't have a finish_reason field directly;
        // the response.status === 'completed' is the signal.
        finishReason = completed.status ?? null
      }
    }
    yield {
      type: 'stop',
      stopReason: finishReason,
      usage: toUsage(usage),
    }
  }

  // ─── runWithTools / streamWithTools ─────────────────────────────────────

  override async runWithTools(
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
      return await this._runResponsesLoop(messages, [...tools, ...resolved.tools], options)
    } finally {
      await resolved.close()
    }
  }

  private async _runResponsesLoop(
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
      checkAborted(options.signal)
      const params = this.buildResponsesParams(workingMessages, options, tools)
      const response = await this.client.responses.create(params, reqOpts(options))
      addUsage(aggregated, response.usage)

      const assistantBlocks = fromResponsesOutput(response.output)
      const toolCalls = response.output.filter(
        (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call',
      )
      workingMessages.push({ role: 'assistant', content: assistantBlocks })

      if (toolCalls.length === 0) {
        const text = textFromOutput(response.output)
        return {
          text,
          messages: workingMessages,
          iterations,
          stopReason: response.status ?? 'completed',
          usage: aggregated,
        }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        let parsedInput: unknown = {}
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.arguments ? JSON.parse(call.arguments) : {}
        } catch (err) {
          parseFailed = await tryRecoverParseError(
            call.name,
            call.call_id,
            err as Error,
            options,
          )
        }
        const { content, isError } = parseFailed ?? await runToolWithRecovery(
          toolMap.get(call.name),
          call.name,
          call.call_id,
          parsedInput,
          options,
        )
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.call_id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        const text = textFromOutput(response.output)
        return {
          text,
          messages: workingMessages,
          iterations,
          stopReason: 'max_iterations',
          usage: aggregated,
        }
      }
    }
  }

  override async *streamWithTools(
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
      yield* this._streamResponsesLoop(messages, [...tools, ...resolved.tools], options)
    } finally {
      await resolved.close()
    }
  }

  private async *_streamResponsesLoop(
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

      const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
        ...this.buildResponsesParams(workingMessages, options, tools),
        stream: true,
      }
      const stream = await this.client.responses.create(params, reqOpts(options))
      let finishReason: string | null = null
      let finalResponse: OpenAI.Responses.Response | undefined

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          const delta = (event as { delta: string }).delta
          if (delta && delta.length > 0) yield { type: 'text', delta }
        } else if (event.type === 'response.completed') {
          const completed = (event as { response: OpenAI.Responses.Response }).response
          finalResponse = completed
          finishReason = completed.status ?? null
        }
      }

      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      if (!finalResponse) {
        // The stream ended without a completion event — surface the
        // best stop we have and bail.
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'incomplete',
          iterations,
          usage: aggregated,
          messages: workingMessages,
        }
        return
      }

      addUsage(aggregated, finalResponse.usage)
      const assistantBlocks = fromResponsesOutput(finalResponse.output)
      workingMessages.push({ role: 'assistant', content: assistantBlocks })

      const toolCalls = finalResponse.output.filter(
        (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call',
      )
      if (toolCalls.length === 0) {
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'completed',
          iterations,
          usage: aggregated,
          messages: workingMessages,
        }
        return
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        let parsedInput: unknown = {}
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.arguments ? JSON.parse(call.arguments) : {}
        } catch (err) {
          parseFailed = await tryRecoverParseError(
            call.name,
            call.call_id,
            err as Error,
            options,
          )
        }
        yield { type: 'tool_use', id: call.call_id, name: call.name, input: parsedInput }
        const { content, isError } = parseFailed ?? await runToolWithRecovery(
          toolMap.get(call.name),
          call.name,
          call.call_id,
          parsedInput,
          options,
        )
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.call_id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
        yield {
          type: 'tool_result',
          id: call.call_id,
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

  // ─── Schema variants throw — deferred ──────────────────────────────────

  override async generate<T>(
    _messages: readonly Message[],
    _schema: OutputSchema<T>,
    _options: ChatOptions = {},
  ): Promise<GenerateResult<T>> {
    throw new BrainError(
      'OpenAIResponsesProvider.generate: structured output via the Responses API is a follow-up slice. For json-schema structured output today, route the call to the chat completions provider (driver: "openai").',
      { context: { provider: this.name } },
    )
  }

  override async runWithToolsAndSchema<T>(
    _messages: readonly Message[],
    _tools: readonly Tool[],
    _schema: OutputSchema<T>,
    _options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>> {
    throw new BrainError(
      'OpenAIResponsesProvider.runWithToolsAndSchema: combined tools + schema on the Responses API is a follow-up slice. Run runTools + generate as separate calls, or route to the chat completions provider for this combination.',
      { context: { provider: this.name } },
    )
  }

  override async *streamWithToolsAndSchema<T>(
    _messages: readonly Message[],
    _tools: readonly Tool[],
    _schema: OutputSchema<T>,
    _options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<T>> {
    throw new BrainError(
      'OpenAIResponsesProvider.streamWithToolsAndSchema: streaming + tools + schema on the Responses API is a follow-up slice. Use streamTools without schema, or route to the chat completions provider.',
      { context: { provider: this.name } },
    )
  }

  // ─── Param translation ──────────────────────────────────────────────────

  private buildResponsesParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): OpenAI.Responses.ResponseCreateParamsNonStreaming {
    const model = options.model ?? this.defaultModel
    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model,
      input: messages.flatMap((m) => {
        const r = toResponsesInputItem(m)
        return Array.isArray(r) ? r : [r]
      }) as unknown as OpenAI.Responses.ResponseInput,
      max_output_tokens: options.maxTokens ?? this.defaultMaxTokens,
    }
    const systemText = systemPromptText(options.system)
    if (systemText.length > 0) params.instructions = systemText

    const toolEntries: ResponsesTool[] = []
    for (const t of tools) {
      toolEntries.push({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      })
    }
    if (options.serverTools && options.serverTools.length > 0) {
      toolEntries.push(...responsesServerTools(options.serverTools))
    }
    if (toolEntries.length > 0) {
      params.tools = toolEntries as unknown as OpenAI.Responses.ResponseCreateParams['tools']
    }

    // Reasoning controls — gpt-5 and o-series only. Emit when set;
    // non-reasoning models reject.
    if (options.effort !== undefined) {
      params.reasoning = { effort: options.effort } as OpenAI.Responses.ResponseCreateParams['reasoning']
    } else if (options.thinking === 'adaptive') {
      params.reasoning = { effort: 'medium' } as OpenAI.Responses.ResponseCreateParams['reasoning']
    } else if (options.thinking === 'disabled') {
      params.reasoning = { effort: 'minimal' } as OpenAI.Responses.ResponseCreateParams['reasoning']
    }

    return params
  }

  private toChatResultFromResponse(
    response: OpenAI.Responses.Response,
    requestedModel: string,
  ): ChatResult<OpenAI.Responses.Response> {
    return {
      text: textFromOutput(response.output),
      model: response.model ?? requestedModel,
      stopReason: response.status ?? null,
      usage: toUsage(response.usage),
      raw: response,
    }
  }
}

// ─── Translation helpers ──────────────────────────────────────────────────

function systemPromptText(system: SystemPrompt | undefined): string {
  if (system === undefined) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map((b) => b.text).join('\n')
  return system.text
}

/**
 * Translate a framework `Message` into a Responses API input item.
 * V1 covers text + tool_use + tool_result; other content blocks
 * (image / document / audio) fall back to text concatenation until
 * the Responses API multimodal slice ships.
 */
function toResponsesInputItem(message: Message): unknown {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content }
  }
  // For user-role tool results, emit one `function_call_output` per
  // tool_result block. The Responses API wants each result as its
  // own input item, NOT bundled in a message turn.
  if (message.role === 'user') {
    const toolResults = message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
    if (toolResults.length > 0) {
      // Multi-item return — caller handles arrays in input.
      const items: unknown[] = []
      const remainingText: string[] = []
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : block.content.map((t) => t.text).join('')
          items.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: content,
          })
        } else if (block.type === 'text') {
          remainingText.push(block.text)
        }
      }
      if (remainingText.length > 0) {
        items.unshift({ role: 'user', content: remainingText.join('') })
      }
      return items
    }
    // Plain user message with mixed blocks → flatten text.
    return {
      role: 'user',
      content: message.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    }
  }
  // Assistant turn with tool_use blocks → emit function_call items.
  const items: unknown[] = []
  const textParts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }
  if (textParts.length > 0) {
    items.unshift({ role: 'assistant', content: textParts.join('') })
  }
  return items.length === 1 ? items[0] : items
}

/**
 * Extract framework `ContentBlock[]` from a Responses API output
 * array — text from `output_message.content[].text`, tool calls
 * from `function_call` items. Server-tool calls (web_search,
 * code_interpreter) are not surfaced as blocks; they live on
 * `response.output` and apps inspect via `raw` for now.
 */
function fromResponsesOutput(
  output: readonly OpenAI.Responses.ResponseOutputItem[],
): string | ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const item of output) {
    if (item.type === 'message' && item.role === 'assistant') {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          blocks.push({ type: 'text', text: part.text })
        }
      }
    } else if (item.type === 'function_call') {
      let parsed: unknown = {}
      try {
        parsed = item.arguments ? JSON.parse(item.arguments) : {}
      } catch {
        parsed = item.arguments ?? {}
      }
      blocks.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parsed,
      } satisfies ToolUseBlock)
    }
    // Server-tool result items (web_search_call, code_interpreter_call,
    // etc.) are surfaced on `raw` — V1 doesn't add framework blocks
    // for them; apps inspect raw when they care.
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text
  return blocks
}

function textFromOutput(output: readonly OpenAI.Responses.ResponseOutputItem[]): string {
  const parts: string[] = []
  for (const item of output) {
    if (item.type === 'message' && item.role === 'assistant') {
      for (const p of item.content) {
        if (p.type === 'output_text') parts.push(p.text)
      }
    }
  }
  return parts.join('')
}

function responsesServerTools(serverTools: readonly ServerTool[]): ResponsesTool[] {
  const out: ResponsesTool[] = []
  for (const t of serverTools) {
    if (t.type === 'web_search') {
      out.push({ type: 'web_search' })
    } else if (t.type === 'code_execution') {
      out.push({ type: 'code_interpreter', container: { type: 'auto' } })
    } else if (t.type === 'web_fetch') {
      throw new BrainError(
        'OpenAIResponsesProvider: server tool `web_fetch` is Anthropic-only. Use `web_search` for OpenAI, or route to Anthropic.',
        { context: { provider: 'openai-responses' } },
      )
    } else if (t.type === 'url_context') {
      throw new BrainError(
        'OpenAIResponsesProvider: server tool `url_context` is Gemini-only. Route to Gemini, or include the URL in the prompt and use `web_search`.',
        { context: { provider: 'openai-responses' } },
      )
    }
  }
  return out
}

function toUsage(u: OpenAI.Responses.ResponseUsage | undefined): ChatUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
  }
}

function addUsage(acc: ChatUsage, u: OpenAI.Responses.ResponseUsage | undefined): void {
  if (!u) return
  acc.inputTokens += u.input_tokens ?? 0
  acc.outputTokens += u.output_tokens ?? 0
  acc.cacheReadTokens += u.input_tokens_details?.cached_tokens ?? 0
}

function reqOpts(options: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return options.signal !== undefined ? { signal: options.signal } : undefined
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

/**
 * Handle a JSON.parse failure on a `function_call.arguments` field
 * through the standard `onToolError` recovery hook. Returns a
 * recovery result or rethrows as ToolExecutionError. Kept inline
 * (not in tool_runner.ts) because the call shape — error-only,
 * pre-execute — differs from the standard path.
 */
async function tryRecoverParseError(
  toolName: string,
  callId: string,
  cause: Error,
  options: RunWithToolsOptions,
): Promise<{ content: string; isError: boolean }> {
  const { ToolExecutionError } = await import('../tool_execution_error.ts')
  const err = new ToolExecutionError(
    toolName,
    callId,
    new Error(`Failed to parse tool input JSON: ${cause.message}`),
  )
  const recovered = options.onToolError?.(err)
  if (typeof recovered !== 'string') throw err
  return { content: recovered, isError: true }
}
