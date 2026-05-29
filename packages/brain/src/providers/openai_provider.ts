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
 *   - `MCPServer[]` → throws `BrainError`. OpenAI has no
 *     server-side MCP support; the local MCP client slice
 *     (`@strav/brain/mcp`) lands when this is needed.
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
import type { Provider, RunWithToolsOptions } from '../provider.ts'
import type { Tool } from '../tool.ts'
import { ToolExecutionError } from '../tool_execution_error.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  Message,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.ts'

const DEFAULT_OPENAI_MODEL = 'gpt-5'

export class OpenAIProvider implements Provider {
  readonly name: string
  private readonly client: OpenAI
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number

  constructor(
    name: string,
    config: OpenAIProviderConfig,
    options: { client?: OpenAI } = {},
  ) {
    this.name = name
    this.defaultModel = config.defaultModel ?? DEFAULT_OPENAI_MODEL
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096
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
    const response = await this.client.chat.completions.create(params)
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
    const stream = await this.client.chat.completions.create(params)
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

  async runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): Promise<AgentResult> {
    if (options.mcpServers && options.mcpServers.length > 0) {
      throw new BrainError(
        'OpenAIProvider.runWithTools: MCP servers are not supported by the OpenAI provider in V1. Use the Anthropic provider for server-side MCP, or wait for the local MCP client slice.',
        { context: { provider: this.name } },
      )
    }
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
      const response = await this.client.chat.completions.create(params)
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
      for (const call of toolCalls) {
        if (call.type !== 'function') continue
        const tool = toolMap.get(call.function.name)
        if (!tool) {
          throw new ToolExecutionError(
            call.function.name,
            call.id,
            new Error(`Tool "${call.function.name}" is not registered.`),
          )
        }
        let parsedInput: unknown
        try {
          parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch (err) {
          throw new ToolExecutionError(
            call.function.name,
            call.id,
            new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
          )
        }
        let output: unknown
        try {
          output = await tool.execute(parsedInput, {
            callId: call.id,
            context: options.context ?? {},
          })
        } catch (cause) {
          throw new ToolExecutionError(call.function.name, call.id, cause)
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
          text: assistantMessage.content ?? '',
          messages: workingMessages,
          iterations,
          stopReason: 'max_iterations',
          usage: aggregated,
        }
      }
    }
  }

  // ─── Param translation ──────────────────────────────────────────────────

  private buildParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
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

  // User-role multi-block content — flatten text. MCP blocks (which
  // are read-only and Anthropic-specific) are silently dropped.
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
