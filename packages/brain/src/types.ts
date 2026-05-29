/**
 * Public types for the brain runtime.
 *
 * Apps work with three high-level shapes:
 *
 *   - `Message` — a user/assistant turn in a conversation. `content` is
 *     either a plain string or a list of `ContentBlock`s for richer
 *     payloads (cached blocks, images in a later slice).
 *
 *   - `ChatOptions` — per-call knobs: model selection (explicit `model`
 *     or `tier` sugar), `system` prompt with optional cache flag,
 *     `maxTokens`, `thinking`, `effort`, etc.
 *
 *   - `ChatResult` — what comes back from `chat()`: assistant `text`,
 *     `usage` (including cache hit/miss counters), `stopReason`, the
 *     `model` that actually answered, and a `raw` escape hatch with the
 *     provider's native response.
 *
 * The streaming side adds `StreamEvent` — a discriminated union of the
 * events a provider emits while a response is being generated. V1
 * covers text deltas, the final-message event, and `stopReason`;
 * thinking blocks / tool-use streams land when those features ship.
 */

/** Coarse-grained model tier. Sugar for "fast / balanced / powerful" without naming an SDK. */
export type ModelTier = 'fast' | 'balanced' | 'powerful'

/**
 * A text content block. The `cache` flag lets apps mark long, stable
 * prefixes for prompt caching; providers translate this to whatever
 * cache mechanism their SDK exposes (Anthropic: `cache_control:
 * {type: 'ephemeral'}`).
 */
export interface TextBlock {
  type: 'text'
  text: string
  /** Mark this block as a cache breakpoint. Default `false`. */
  cache?: boolean
}

export type ContentBlock = TextBlock

/** A single conversation turn. `content` can be a bare string or a typed block list. */
export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/**
 * The `system` prompt. Either a plain string (no cache) or a structured
 * form that lets apps mark the prompt as cached. Apps that want
 * fine-grained control over multi-block system prompts pass an array.
 */
export type SystemPrompt =
  | string
  | { text: string; cache?: boolean }
  | Array<{ text: string; cache?: boolean }>

/**
 * Per-call options. Generics are deliberately conservative — apps
 * don't usually need to type-narrow the provider response; the `raw`
 * escape hatch in `ChatResult` is what they reach for when they need
 * provider-specific fields.
 */
export interface ChatOptions {
  /** Override the configured default model. Wins over `tier`. */
  model?: string
  /** Sugar for selecting a model by tier. Resolved against `config.brain.tiers`. */
  tier?: ModelTier
  /** System prompt — typed shape supports prompt caching. */
  system?: SystemPrompt
  /** Hard ceiling on response tokens. Default `4096`. */
  maxTokens?: number
  /**
   * Adaptive thinking control. `'adaptive'` enables it; `'disabled'`
   * (or omission) turns it off. On Opus 4.7 + 4.6 / Sonnet 4.6 this
   * is the only supported thinking mode — `budget_tokens` is removed
   * upstream and not exposed here.
   */
  thinking?: 'adaptive' | 'disabled'
  /** Effort hint. `low` / `medium` / `high` / `xhigh` / `max`. Defaults to provider's pick. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * Top-level cache_control toggle. When `true` the provider asks the
   * SDK to auto-cache the last cacheable block on every request.
   * Defaults to `config.brain.cache.auto ?? false`.
   */
  cache?: boolean
  /**
   * Beta features to enable on this request. Pass through to the
   * provider's beta-header machinery. Provider-specific.
   */
  betas?: readonly string[]
  /**
   * Provider-specific overrides. `BrainManager.chat` selects the
   * provider by config; this is the override for that.
   */
  provider?: string
}

/** Token usage for a single call. Cache-hit fields are populated when caching is in play. */
export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * The provider's reply. `text` is the concatenated assistant text;
 * `raw` is the provider's full native response shape for apps that
 * need anything we don't surface (e.g. citation blocks, server-tool
 * results once those ship).
 */
export interface ChatResult<Raw = unknown> {
  text: string
  model: string
  stopReason: string | null
  usage: ChatUsage
  raw: Raw
}

/**
 * Streaming event union. V1 covers the text-delta + completion path
 * apps want for chat-style UIs; thinking blocks and tool-use streams
 * are reserved for later slices.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'stop'; stopReason: string | null; usage: ChatUsage }
