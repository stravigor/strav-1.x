/**
 * Pure-function mappers for OpenAI chat-completions responses back
 * into framework shapes (`ContentBlock[]`, `ChatUsage`, `ChatResult`).
 * Extracted from `OpenAIBrainDriver` so the response-shape translation
 * can be unit-tested in isolation and reused by the OpenAI-compat
 * subclasses without going through the driver class.
 */

import type OpenAI from 'openai'
import type {
  ChatResult,
  ChatUsage,
  ContentBlock,
  ToolUseBlock,
} from '../../types.ts'

export function fromOpenAIAssistantMessage(
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

export function toOpenAIUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
  }
}

export function addOpenAIUsage(acc: ChatUsage, u: OpenAI.CompletionUsage | undefined): void {
  if (!u) return
  acc.inputTokens += u.prompt_tokens
  acc.outputTokens += u.completion_tokens
  acc.cacheReadTokens += u.prompt_tokens_details?.cached_tokens ?? 0
}

export function toOpenAIChatResult(
  response: OpenAI.Chat.ChatCompletion,
): ChatResult<OpenAI.Chat.ChatCompletion> {
  const choice = response.choices[0]
  return {
    text: choice?.message?.content ?? '',
    model: response.model,
    stopReason: choice?.finish_reason ?? null,
    usage: toOpenAIUsage(response.usage),
    raw: response,
  }
}
