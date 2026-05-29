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

/**
 * Provider-emitted tool-use block. Appears in `assistant`-role
 * messages when the model decides to call a tool. `input` is the
 * parsed JSON the model produced for the tool's `inputSchema`; apps
 * that need to validate it (Zod, ajv, etc.) do so at the call site.
 *
 * The agentic loop creates a matching `ToolResultBlock` and appends
 * it to the next `user`-role message before re-asking the model.
 */
export interface ToolUseBlock {
  type: 'tool_use'
  /** Provider-assigned call id. The matching tool_result references this verbatim. */
  id: string
  /** Tool name — matches a registered `Tool.name`. */
  name: string
  /** Parsed input the model produced. Apps validate against the tool's schema. */
  input: unknown
}

/**
 * Result of executing a tool. Appended to a `user`-role message and
 * fed back to the model. `content` is either a plain string (the
 * common case) or a list of text blocks for richer payloads. Mark
 * `isError: true` so the model knows the tool call failed and can
 * adjust its approach.
 */
export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string | TextBlock[]
  isError?: boolean
}

/**
 * Provider-emitted MCP tool-use block. Read-only — apps don't construct
 * these; they appear in `assistant`-role messages when the model calls
 * a tool exposed by a configured MCP server. Anthropic's backend
 * invokes the MCP server itself and inlines the result as an
 * `MCPToolResultBlock` in the same response, so the framework's
 * agentic loop doesn't need to handle the call.
 *
 * Apps render these for observability (showing users that the model
 * consulted Linear / Notion / GitHub via MCP) and for audit trails.
 */
export interface MCPToolUseBlock {
  type: 'mcp_tool_use'
  id: string
  /** MCP server identifier — matches `MCPServer.name`. */
  serverName: string
  /** Tool name as exposed by the MCP server. */
  name: string
  /** Parsed input the model passed to the MCP tool. */
  input: unknown
}

/**
 * Provider-emitted MCP tool result. Pairs with `MCPToolUseBlock` by
 * `toolUseId`. `content` is either a string or text blocks; `isError`
 * is `true` when the MCP server returned an error.
 */
export interface MCPToolResultBlock {
  type: 'mcp_tool_result'
  toolUseId: string
  content: string | TextBlock[]
  isError?: boolean
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | MCPToolUseBlock
  | MCPToolResultBlock

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
  /**
   * Cancel the in-flight operation. Aborting between iterations of
   * a tool loop bails before the next model call; aborting mid-call
   * propagates the SDK's native abort error (typically a `DOMException`
   * with `name: 'AbortError'`). Streaming iterators reject on the
   * next `for await` step.
   */
  signal?: AbortSignal
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

/**
 * Result of a structured-output call. `value` is the parsed JSON
 * shaped to the `OutputSchema<T>` passed in. `text` is the raw JSON
 * string the model produced (useful for logging / debugging when
 * `parse` rejects). `raw` is the provider's full native response.
 */
export interface GenerateResult<T = unknown, Raw = unknown> {
  value: T
  text: string
  model: string
  stopReason: string | null
  usage: ChatUsage
  raw: Raw
}
