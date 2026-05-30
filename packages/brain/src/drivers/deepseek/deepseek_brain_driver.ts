/**
 * `DeepSeekBrainDriver` — `OpenAICompatBrainDriver` pointed at DeepSeek's
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
import { BrainError } from '../../brain_error.ts'
import type { DeepSeekProviderConfig } from '../../brain_config.ts'
import type { ResolveMcpToolsOptions } from '../../mcp/resolve_mcp_tools.ts'
import type {
  AudioSource,
  ChatUsage,
  EmbedOptions,
  EmbedResult,
  TranscribeOptions,
  TranscribeResult,
} from '../../types.ts'
import { OpenAICompatBrainDriver } from '../openai_compat/openai_compat_brain_driver.ts'

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

export class DeepSeekBrainDriver extends OpenAICompatBrainDriver {
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
   * DeepSeek doesn't expose an audio transcription endpoint.
   * Override the inherited `transcribe` (from OpenAIBrainDriver) to
   * throw clearly rather than 404 at the wire.
   */
  override async transcribe(
    _audio: AudioSource,
    _options?: TranscribeOptions,
  ): Promise<TranscribeResult<OpenAI.Audio.TranscriptionCreateResponse>> {
    throw new BrainError(
      "DeepSeekBrainDriver.transcribe: DeepSeek's API does not expose audio transcription. Route transcribe calls to a provider with native support — OpenAI / Ollama / Gemini.",
      { context: { provider: this.name } },
    )
  }

  /**
   * DeepSeek doesn't expose an embeddings endpoint via their
   * OpenAI-compat API. Override the inherited `embed` to throw
   * with a clear message instead of letting the SDK return a
   * confusing 404.
   */
  override async embed(
    _texts: readonly string[],
    _options?: EmbedOptions,
  ): Promise<EmbedResult<OpenAI.CreateEmbeddingResponse>> {
    throw new BrainError(
      `DeepSeekBrainDriver.embed: DeepSeek's API does not expose embeddings. Route embed calls to a provider with native support — OpenAI / Gemini / Ollama.`,
      { context: { provider: this.name } },
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
