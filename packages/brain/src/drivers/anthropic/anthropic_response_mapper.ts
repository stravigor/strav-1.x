/**
 * Pure-function mappers for Anthropic message responses back into
 * framework shapes (`ContentBlock[]`, `ChatUsage`, `ChatResult`).
 * Extracted from `AnthropicBrainDriver` so the response-shape
 * translation can be unit-tested in isolation.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type {
  ChatResult,
  ChatUsage,
  CompactionBlock,
  ContentBlock,
  MCPToolResultBlock,
  MCPToolUseBlock,
  TextBlock,
  ToolUseBlock,
} from '../../types.ts'
import { collectText } from './anthropic_helpers.ts'

export function toAnthropicUsage(u: Anthropic.Usage): ChatUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  }
}

export function addAnthropicUsage(acc: ChatUsage, u: Anthropic.Usage): void {
  acc.inputTokens += u.input_tokens
  acc.outputTokens += u.output_tokens
  acc.cacheReadTokens += u.cache_read_input_tokens ?? 0
  acc.cacheCreationTokens += u.cache_creation_input_tokens ?? 0
}

export function toAnthropicChatResult(
  message: Anthropic.Message,
): ChatResult<Anthropic.Message> {
  const text = collectText(message.content)
  const result: ChatResult<Anthropic.Message> = {
    text,
    model: message.model,
    stopReason: message.stop_reason,
    usage: toAnthropicUsage(message.usage),
    raw: message,
  }
  // Surface structured content when the turn carries blocks
  // beyond plain text (compaction today; reasoning blocks in a
  // future slice). Apps that persist conversations push this
  // onto the message history so round-trippable blocks survive
  // subsequent requests.
  const blocks = fromAnthropicContent(message.content)
  if (blocks.some((b) => b.type !== 'text')) {
    result.content = blocks
  }
  return result
}

/**
 * Translate the SDK's response content blocks back into framework
 * `ContentBlock`s for storage in `workingMessages`. We preserve
 * `text` and `tool_use` blocks verbatim; other server-side block
 * types (thinking, server tool blocks) are dropped — V1 doesn't
 * surface them, and re-sending them as part of the assistant turn
 * could confuse the model.
 */
export function fromAnthropicContent(
  content: ReadonlyArray<Anthropic.ContentBlock | { type: string; [k: string]: unknown }>,
): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: (block as { text: string }).text } satisfies TextBlock)
    } else if (block.type === 'tool_use') {
      const u = block as { id: string; name: string; input: unknown }
      out.push({
        type: 'tool_use',
        id: u.id,
        name: u.name,
        input: u.input,
      } satisfies ToolUseBlock)
    } else if (block.type === 'mcp_tool_use') {
      const m = block as unknown as {
        id: string
        server_name: string
        name: string
        input: unknown
      }
      out.push({
        type: 'mcp_tool_use',
        id: m.id,
        serverName: m.server_name,
        name: m.name,
        input: m.input,
      } satisfies MCPToolUseBlock)
    } else if (block.type === 'mcp_tool_result') {
      const r = block as unknown as {
        tool_use_id: string
        content: string | Array<{ type: 'text'; text: string }>
        is_error?: boolean
      }
      const result: MCPToolResultBlock = {
        type: 'mcp_tool_result',
        toolUseId: r.tool_use_id,
        content:
          typeof r.content === 'string'
            ? r.content
            : r.content.map((c) => ({ type: 'text', text: c.text }) satisfies TextBlock),
      }
      if (r.is_error) result.isError = true
      out.push(result)
    } else if (block.type === 'compaction') {
      const c = block as { content?: string | null; encrypted_content?: string | null }
      out.push({
        type: 'compaction',
        content: c.content ?? null,
        encryptedContent: c.encrypted_content ?? null,
      } satisfies CompactionBlock)
    }
  }
  return out
}
