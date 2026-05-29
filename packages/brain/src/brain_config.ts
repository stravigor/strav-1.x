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

export type ProviderConfig = AnthropicProviderConfig // | OpenAIProviderConfig | … (later slices)

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
