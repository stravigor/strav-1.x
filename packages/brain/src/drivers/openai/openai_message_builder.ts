/**
 * Pure-function builders for the OpenAI chat-completions request
 * payload. Separated from `OpenAIBrainDriver` so the wire-shape
 * translation can be unit-tested without instantiating an SDK
 * client, and so OpenAI-compat subclasses can reuse the same
 * primitives without inheriting through a 1000+ LOC base file.
 */

import type OpenAI from 'openai'
import { BrainError } from '../../brain_error.ts'
import type { ChatOptions } from '../../types.ts'
import type { Tool } from '../../tool.ts'
import type {
  ImageBlock,
  Message,
  SystemPrompt,
  TextBlock,
  ToolUseBlock,
} from '../../types.ts'

/** Defaults the driver injects when the call site omits them. */
export interface OpenAIBuildDefaults {
  defaultModel: string
  defaultMaxTokens: number
}

export function systemPromptText(system: SystemPrompt | undefined): string {
  if (system === undefined) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map((b) => b.text).join('\n')
  return system.text
}

export function toOpenAIMessage(message: Message): OpenAI.Chat.ChatCompletionMessageParam {
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

  for (const block of message.content) {
    if (block.type === 'document') {
      throw new BrainError(
        "OpenAIBrainDriver: document blocks are not supported on OpenAI's chat completions API. For PDFs, split the document to images (one per page) and send them as ImageBlocks on a vision-capable model (gpt-5 / gpt-4o family); or route document workloads to Anthropic / Gemini, which accept PDF blocks natively.",
        { context: { provider: 'openai' } },
      )
    }
    if (block.type === 'audio') {
      throw new BrainError(
        "OpenAIBrainDriver: audio blocks are not supported on OpenAI's chat completions API. Transcribe audio upstream via OpenAI's Whisper / gpt-4o-transcribe and send the resulting text; or route audio workloads to Gemini, which accepts audio blocks natively.",
        { context: { provider: 'openai' } },
      )
    }
  }

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
    }
    return { role: 'user', content: parts }
  }
  const text = message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { role: 'user', content: text }
}

export function toOpenAIMessages(
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
            content:
              typeof block.content === 'string'
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

export function buildOpenAIChatParams(
  messages: readonly Message[],
  options: ChatOptions,
  tools: readonly Tool[],
  defaults: OpenAIBuildDefaults,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  if (options.serverTools && options.serverTools.length > 0) {
    throw new BrainError(
      "OpenAIBrainDriver: server tools (web_search / code_execution / web_fetch / url_context) are not supported on OpenAI's chat completions API. OpenAI's server tools live on the Responses API (separate provider slice). Run them as framework-local tools, route to Anthropic / Gemini, or wait for the OpenAIResponsesBrainDriver slice.",
      { context: { provider: 'openai' } },
    )
  }
  const model = options.model ?? defaults.defaultModel
  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    max_completion_tokens: options.maxTokens ?? defaults.defaultMaxTokens,
    messages: toOpenAIMessages(options.system, messages),
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
  return params
}
