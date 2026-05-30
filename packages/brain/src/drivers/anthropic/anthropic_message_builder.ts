/**
 * Pure-function builders for the Anthropic messages-create request
 * payload. Separated from `AnthropicBrainDriver` so the wire-shape
 * translation can be unit-tested without instantiating an SDK
 * client.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { BrainError } from '../../brain_error.ts'
import type { ChatOptions } from '../../types.ts'
import type {
  ContentBlock,
  MCPToolResultBlock,
  MCPToolUseBlock,
  Message,
  ServerTool,
  SystemPrompt,
} from '../../types.ts'
import { mergeBetas } from './anthropic_helpers.ts'

/** Compaction beta — required header + `edits[].type` for `compact-2026-01-12`. */
export const COMPACT_BETA = 'compact-2026-01-12'
export const COMPACT_EDIT_TYPE = 'compact_20260112'

const EPHEMERAL_CACHE = { type: 'ephemeral' } as const

/** Defaults the driver injects when the call site omits them. */
export interface AnthropicBuildDefaults {
  defaultModel: string
  defaultMaxTokens: number
  betas: readonly string[]
}

export function toMessageParam(message: Message): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content }
  }
  return {
    role: message.role,
    content: message.content
      // MCP blocks are inbound-only — Anthropic produces them, we
      // surface them on `result.messages` for observability, but we
      // never echo them back to the model. The backend tracks MCP
      // tool state on its side.
      .filter(
        (b): b is Exclude<ContentBlock, MCPToolUseBlock | MCPToolResultBlock> =>
          b.type !== 'mcp_tool_use' && b.type !== 'mcp_tool_result',
      )
      .map((block): Anthropic.ContentBlockParam => {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          }
        }
        if (block.type === 'tool_result') {
          const param: Anthropic.ToolResultBlockParam = {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content:
              typeof block.content === 'string'
                ? block.content
                : block.content.map(
                    (b) => ({ type: 'text', text: b.text }) as Anthropic.TextBlockParam,
                  ),
          }
          if (block.isError) param.is_error = true
          return param
        }
        if (block.type === 'image') {
          return {
            type: 'image',
            source:
              block.source.type === 'base64'
                ? {
                    type: 'base64',
                    media_type:
                      block.source.mediaType as Anthropic.Base64ImageSource['media_type'],
                    data: block.source.data,
                  }
                : { type: 'url', url: block.source.url },
          } satisfies Anthropic.ImageBlockParam
        }
        if (block.type === 'document') {
          const documentParam: Anthropic.DocumentBlockParam = {
            type: 'document',
            source:
              block.source.type === 'base64'
                ? {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: block.source.data,
                  }
                : { type: 'url', url: block.source.url },
          }
          if (block.title !== undefined) documentParam.title = block.title
          return documentParam
        }
        if (block.type === 'audio') {
          throw new BrainError(
            "AnthropicBrainDriver: audio blocks are not supported. Anthropic's SDK does not expose an audio block type for chat messages. Route audio workloads to Gemini, or transcribe upstream and pass the text.",
            { context: { provider: 'anthropic' } },
          )
        }
        if (block.type === 'compaction') {
          // Round-trip the compaction block verbatim — the server uses
          // the opaque `encrypted_content` to stitch prior compactions
          // together; mutating either field would invalidate the
          // history. Untyped on the stable SDK surface; cast through
          // the beta type shape.
          const param: Record<string, unknown> = { type: 'compaction' }
          if (block.content !== null) param.content = block.content
          if (block.encryptedContent !== null) {
            param.encrypted_content = block.encryptedContent
          }
          return param as unknown as Anthropic.ContentBlockParam
        }
        const text: Anthropic.TextBlockParam = { type: 'text', text: block.text }
        if (block.cache) text.cache_control = EPHEMERAL_CACHE
        return text
      }),
  }
}

export function toSystemParam(
  system: SystemPrompt | undefined,
): string | Anthropic.TextBlockParam[] | undefined {
  if (system === undefined) return undefined
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((block) => {
      const param: Anthropic.TextBlockParam = { type: 'text', text: block.text }
      if (block.cache) param.cache_control = EPHEMERAL_CACHE
      return param
    })
  }
  const param: Anthropic.TextBlockParam = { type: 'text', text: system.text }
  if (system.cache) param.cache_control = EPHEMERAL_CACHE
  return [param]
}

/**
 * Translate framework `ServerTool[]` into Anthropic's typed
 * server-tool entries. Uses the latest SDK-known versions; the
 * Anthropic backend is backward-compatible to older clients
 * pinning earlier dates, but we standardize on current. Web fetch
 * is Anthropic-only; `url_context` is rejected (Gemini-only).
 */
export function anthropicServerTools(serverTools: readonly ServerTool[]): Anthropic.ToolUnion[] {
  const out: Anthropic.ToolUnion[] = []
  for (const t of serverTools) {
    if (t.type === 'web_search') {
      const tool: Anthropic.WebSearchTool20260209 = {
        type: 'web_search_20260209',
        name: 'web_search',
      }
      if (t.maxUses !== undefined) {
        ;(tool as { max_uses?: number }).max_uses = t.maxUses
      }
      if (t.allowedDomains !== undefined) {
        tool.allowed_domains = [...t.allowedDomains]
      }
      if (t.blockedDomains !== undefined) {
        tool.blocked_domains = [...t.blockedDomains]
      }
      out.push(tool)
    } else if (t.type === 'code_execution') {
      out.push({
        type: 'code_execution_20260120',
        name: 'code_execution',
      } satisfies Anthropic.CodeExecutionTool20260120)
    } else if (t.type === 'web_fetch') {
      const tool: Anthropic.WebFetchTool20260309 = {
        type: 'web_fetch_20260309',
        name: 'web_fetch',
      }
      if (t.maxUses !== undefined) {
        ;(tool as { max_uses?: number }).max_uses = t.maxUses
      }
      if (t.allowedDomains !== undefined) {
        tool.allowed_domains = [...t.allowedDomains]
      }
      if (t.blockedDomains !== undefined) {
        tool.blocked_domains = [...t.blockedDomains]
      }
      out.push(tool)
    } else if (t.type === 'url_context') {
      throw new BrainError(
        'AnthropicBrainDriver: server tool `url_context` is Gemini-only. Use `web_fetch` for Anthropic or route the call to Gemini.',
        { context: { provider: 'anthropic' } },
      )
    }
  }
  return out
}

export function buildAnthropicMessageParams(
  messages: readonly Message[],
  options: ChatOptions,
  defaults: AnthropicBuildDefaults,
): Anthropic.MessageCreateParamsNonStreaming {
  const model = options.model ?? defaults.defaultModel
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: options.maxTokens ?? defaults.defaultMaxTokens,
    messages: messages.map(toMessageParam),
  }

  const system = toSystemParam(options.system)
  if (system !== undefined) params.system = system

  if (options.thinking === 'adaptive') {
    params.thinking = { type: 'adaptive' }
  } else if (options.thinking === 'disabled') {
    params.thinking = { type: 'disabled' }
  }

  if (options.effort !== undefined) {
    params.output_config = { effort: options.effort }
  }

  if (options.cache === true) {
    // Top-level auto-cache the last cacheable block. Maps to the
    // SDK's `cache_control` shorthand on the request body.
    ;(params as { cache_control?: { type: 'ephemeral' } }).cache_control = EPHEMERAL_CACHE
  }

  // Compaction — emits the beta `edits` entry + flips the
  // `compact-2026-01-12` beta header so the request goes through
  // the SDK's beta surface (same routing as MCP).
  const baseBetas = mergeBetas(defaults.betas, options.betas)
  const betas =
    options.compact !== undefined ? mergeBetas(baseBetas, [COMPACT_BETA]) : baseBetas
  if (options.compact !== undefined) {
    const edit: Record<string, unknown> = { type: COMPACT_EDIT_TYPE }
    if (options.compact.trigger !== undefined) {
      edit.trigger = { type: 'input_tokens', value: options.compact.trigger }
    }
    if (options.compact.instructions !== undefined) {
      edit.instructions = options.compact.instructions
    }
    if (options.compact.pauseAfterCompaction !== undefined) {
      edit.pause_after_compaction = options.compact.pauseAfterCompaction
    }
    ;(params as { edits?: unknown[] }).edits = [edit]
  }
  if (betas.length > 0) {
    ;(params as { betas?: readonly string[] }).betas = betas
  }

  if (options.serverTools && options.serverTools.length > 0) {
    params.tools = anthropicServerTools(options.serverTools)
  }

  return params
}
