/**
 * Brain configuration shape — what `config.brain` looks like.
 *
 * Mirrors the manager-pattern config used by other Strav packages
 * (auth.guards, mail.transports, database.connections): a `default`
 * provider key + a `providers` map keyed by name. Each provider entry
 * carries its driver and driver-specific options.
 *
 * `tiers` map model-tier sugar (`fast` / `balanced` / `powerful`) to
 * concrete model IDs. The `'fast' → claude-haiku-4-5` etc. defaults
 * apply when this section is omitted; apps can rewire to point at,
 * e.g., self-hosted Llama for the `fast` tier.
 *
 * `cache.auto` is the default for `ChatOptions.cache` when the call
 * site doesn't pass one. Prompt caching is opt-in by default — apps
 * that want every long request to cache flip this to `true`.
 */

import type { MCPServer } from './mcp_server.ts'
import type { ModelTier } from './types.ts'

/** Anthropic-specific driver config. */
export interface AnthropicProviderConfig {
  driver: 'anthropic'
  /** API key. Required. Most apps source from `env('ANTHROPIC_API_KEY')`. */
  apiKey: string
  /** Optional override of the SDK's base URL — useful for proxies or test doubles. */
  baseUrl?: string
  /** Default model when neither `options.model` nor `options.tier` is passed. */
  defaultModel?: string
  /** Default `max_tokens` for `chat()` calls that don't specify one. */
  defaultMaxTokens?: number
  /** Optional beta headers added to every request from this provider. */
  betas?: readonly string[]
}

/** OpenAI-specific driver config. */
export interface OpenAIProviderConfig {
  driver: 'openai'
  /** API key. Required. Most apps source from `env('OPENAI_API_KEY')`. */
  apiKey: string
  /** Optional override of the SDK's base URL — useful for proxies, Azure OpenAI, or test doubles. */
  baseUrl?: string
  /** Optional organization id. */
  organization?: string
  /** Default model when neither `options.model` nor `options.tier` is passed. Defaults to `gpt-5`. */
  defaultModel?: string
  /** Default `max_tokens` for `chat()` calls that don't specify one. */
  defaultMaxTokens?: number
}

/** Google (Gemini) driver config — backed by `@google/genai`. */
export interface GeminiProviderConfig {
  driver: 'google'
  /** API key. Required. Most apps source from `env('GOOGLE_API_KEY')` or `env('GEMINI_API_KEY')`. */
  apiKey: string
  /** Optional override of the SDK's base URL — useful for proxies or test doubles. */
  baseUrl?: string
  /** Default model when neither `options.model` nor `options.tier` is passed. Defaults to `gemini-2.5-flash`. */
  defaultModel?: string
  /** Default `max_tokens` for `chat()` calls that don't specify one. */
  defaultMaxTokens?: number
  /** Optional API version pin (`v1` / `v1beta`). */
  apiVersion?: string
}

/** DeepSeek driver config — backed by the `openai` SDK pointed at DeepSeek's OpenAI-compatible endpoint. */
export interface DeepSeekProviderConfig {
  driver: 'deepseek'
  /** API key. Required. Most apps source from `env('DEEPSEEK_API_KEY')`. */
  apiKey: string
  /** Optional override of the SDK's base URL. Defaults to `https://api.deepseek.com/v1`. */
  baseUrl?: string
  /** Default model when neither `options.model` nor `options.tier` is passed. Defaults to `deepseek-chat`. */
  defaultModel?: string
  /** Default `max_tokens` for `chat()` calls that don't specify one. */
  defaultMaxTokens?: number
}

/**
 * Ollama driver config — backed by the `openai` SDK pointed at a
 * local Ollama server's OpenAI-compatible `/v1` endpoint. The same
 * shape works against any OpenAI-compatible local server (LM Studio,
 * llama.cpp's server, vLLM, …) by overriding `baseUrl`.
 */
export interface OllamaProviderConfig {
  driver: 'ollama'
  /**
   * Required — model must be already pulled on the Ollama server
   * (`ollama pull <model>`). No universal default exists because
   * apps install whichever models they need. Common picks for
   * tool-calling: `llama3.2`, `llama3.1`, `qwen2.5`, `mistral`.
   */
  defaultModel: string
  /** Optional override of the SDK's base URL. Defaults to `http://localhost:11434/v1`. */
  baseUrl?: string
  /**
   * Optional API key. Ollama doesn't require one — the SDK demands
   * a non-empty string, so a placeholder is fine and the default
   * (`'ollama'`) works. Override only when running behind a proxy
   * that adds its own auth layer.
   */
  apiKey?: string
  /** Default `max_tokens` for `chat()` calls that don't specify one. */
  defaultMaxTokens?: number
}

export type ProviderConfig =
  | AnthropicProviderConfig
  | OpenAIProviderConfig
  | GeminiProviderConfig
  | DeepSeekProviderConfig
  | OllamaProviderConfig

/** Cache-shape defaults applied when `ChatOptions.cache` is omitted. */
export interface BrainCacheConfig {
  /** Set `cache_control` on the last cacheable block on every request. Default `false`. */
  auto?: boolean
}

export interface BrainConfigShape {
  /** Name of the default provider; must exist in `providers`. */
  default: string
  /** Provider registry. Each entry is one configured backend. */
  providers: Record<string, ProviderConfig>
  /**
   * Model-tier sugar. When omitted, the framework defaults apply:
   *   - fast: 'claude-haiku-4-5'
   *   - balanced: 'claude-sonnet-4-6'
   *   - powerful: 'claude-opus-4-7'
   */
  tiers?: Partial<Record<ModelTier, string>>
  /** Prompt-cache defaults. */
  cache?: BrainCacheConfig
  /**
   * Default MCP servers — declared on every `runWithTools` call
   * unless the per-call options provide their own list. Apps that
   * need different MCP server sets per route override at the call
   * site or via `Agent.mcpServers`.
   */
  mcpServers?: readonly MCPServer[]
}

/**
 * Framework-level tier defaults. Apps that don't override
 * `config.brain.tiers` get these. Lives here so `BrainManager` and
 * the docs both pull from one source.
 */
export const DEFAULT_TIERS: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  powerful: 'claude-opus-4-7',
}

/** The model the framework reaches for when nothing else is specified. */
export const DEFAULT_MODEL = DEFAULT_TIERS.powerful
