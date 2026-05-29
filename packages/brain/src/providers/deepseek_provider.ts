/**
 * `DeepSeekProvider` — `OpenAICompatProvider` pointed at DeepSeek's
 * OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * Inherits the OpenAI-compat overrides (strip `reasoning_effort`,
 * `json_object`-mode generate with schema-in-system-prompt, throws
 * on combined tools + schema) from the base class. Only adds:
 *
 *   - Constructor with DeepSeek defaults — base URL
 *     `https://api.deepseek.com/v1`, default model `deepseek-chat`.
 *
 *   - `mapUsage` override — DeepSeek reports prompt cache hits on
 *     the extension field `prompt_cache_hit_tokens` rather than
 *     OpenAI's `prompt_tokens_details.cached_tokens`.
 *
 * `countTokens` not implemented (DeepSeek has no count endpoint).
 * `BrainManager.countTokens` returns `null` when routed here.
 */

import type OpenAI from 'openai'
import type { DeepSeekProviderConfig } from '../brain_config.ts'
import type { ResolveMcpToolsOptions } from '../mcp/resolve_mcp_tools.ts'
import type { ChatUsage } from '../types.ts'
import { OpenAICompatProvider } from './openai_compat_provider.ts'

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

export interface DeepSeekProviderOptions {
  client?: OpenAI
  /**
   * Internal seam — tests inject a stub MCP client factory so MCP
   * tool resolution doesn't dial the network. Real apps leave it
   * unset; the provider uses the default `MCPClient`.
   */
  mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
}

export class DeepSeekProvider extends OpenAICompatProvider {
  constructor(
    name: string,
    config: DeepSeekProviderConfig,
    options: DeepSeekProviderOptions = {},
  ) {
    super(
      name,
      {
        driver: 'openai',
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
        defaultModel: config.defaultModel ?? DEFAULT_DEEPSEEK_MODEL,
        ...(config.defaultMaxTokens !== undefined
          ? { defaultMaxTokens: config.defaultMaxTokens }
          : {}),
      },
      options,
    )
  }

  /**
   * DeepSeek reports cache hits on `prompt_cache_hit_tokens`
   * (extension field on their `CompletionUsage`). Read it first,
   * falling back to OpenAI's `prompt_tokens_details.cached_tokens`
   * when present.
   */
  protected override mapUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage {
    return {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      cacheReadTokens:
        ((u as unknown as { prompt_cache_hit_tokens?: number } | undefined)
          ?.prompt_cache_hit_tokens) ??
        u?.prompt_tokens_details?.cached_tokens ??
        0,
      cacheCreationTokens: 0,
    }
  }
}
