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

/**
 * Image input — attaches a picture to a user message so vision-
 * capable models can see it alongside the text. V1 covers images
 * only; audio + video defer.
 *
 * `source` is a discriminated union:
 *   - `{ type: 'base64', mediaType, data }` — inline bytes for
 *     uploads, screenshots, attachments your app already holds in
 *     memory. `mediaType` is the IANA MIME (`image/png`,
 *     `image/jpeg`, `image/webp`, `image/gif`); `data` is the
 *     base64-encoded image (no `data:` prefix — the provider
 *     translation adds it where needed).
 *   - `{ type: 'url', url }` — remote image URL. Anthropic, OpenAI,
 *     and Gemini all accept HTTPS URLs; check the provider's
 *     domain allowlist if calls 404 (Anthropic was historically
 *     stricter). For Gemini, GCS URIs (`gs://...`) also work.
 *
 * Vision support is provider- AND model-dependent. Cloud picks:
 * Anthropic Claude 4 family, OpenAI gpt-4o / gpt-5 family, Gemini
 * 2.x. Local: `llama3.2-vision`, `llava`, `qwen2.5-vl` on Ollama.
 * Models without vision either reject the call or ignore the image.
 */
export interface ImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; mediaType: string; data: string }
    | { type: 'url'; url: string }
}

/**
 * Document input — attaches a PDF (V1 only — the providers that
 * support documents currently all gate on `application/pdf`) to a
 * user message. Anthropic surfaces it as a native `document` block;
 * Gemini accepts it via `inlineData` / `fileData` with
 * `application/pdf` mime; OpenAI / Ollama / DeepSeek don't support
 * PDF blocks at all (apps split the PDF to images and use
 * `ImageBlock`s for those vendors).
 *
 * The optional `title` is shown to the model on Anthropic (helpful
 * for multi-document calls — "the contract", "the invoice"); other
 * providers ignore it.
 */
export interface DocumentBlock {
  type: 'document'
  source:
    | { type: 'base64'; mediaType: string; data: string }
    | { type: 'url'; url: string }
  /** Optional title shown to the model (Anthropic uses it; others ignore). */
  title?: string
}

/**
 * Audio input — attaches a sound clip to a user message. V1
 * coverage: Gemini supports audio natively via `inlineData` with
 * audio MIMEs (`audio/mp3`, `audio/wav`, `audio/ogg`, `audio/flac`,
 * `audio/webm`, `audio/aac`). Anthropic + OpenAI + Ollama don't
 * accept audio in their chat APIs — OpenAI apps preprocess via
 * Whisper; Anthropic apps wait for the audio block to land in the
 * SDK; Ollama apps that need audio look at server-side
 * transcription models.
 */
export interface AudioBlock {
  type: 'audio'
  source:
    | { type: 'base64'; mediaType: string; data: string }
    | { type: 'url'; url: string }
}

/**
 * Server-side compaction block. Anthropic's `compact-2026-01-12`
 * beta returns a `compaction` block when an auto-compaction trigger
 * fires during a request. The framework surfaces it on
 * `result.content` and Thread persists it on the assistant turn so
 * subsequent requests echo it back verbatim — the model only sees
 * the summary + opaque blob from then on, and the older raw turns
 * stay out of context.
 *
 * V1 produces these on Anthropic only. Other providers ignore the
 * `compact` option silently, and never emit a `CompactionBlock`.
 *
 * Round-trip invariant: pass the block back unchanged. The
 * `encryptedContent` blob is opaque metadata the server uses to
 * stitch the compaction history together; the framework never
 * mutates it.
 *
 * `content === null` means a compaction attempt failed (e.g.,
 * malformed model output). The server treats these as no-ops on
 * the next request, so apps don't need to special-case them.
 */
export interface CompactionBlock {
  type: 'compaction'
  /** Summary of compacted content. Null when compaction failed. */
  content: string | null
  /** Opaque metadata round-tripped verbatim on subsequent requests. */
  encryptedContent: string | null
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | AudioBlock
  | ToolUseBlock
  | ToolResultBlock
  | MCPToolUseBlock
  | MCPToolResultBlock
  | CompactionBlock

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
/**
 * Server-side tool — work the provider's backend runs on behalf
 * of the model. Unlike framework-local tools (`Tool` /
 * `defineTool`), the model's call doesn't round-trip through
 * the app's process; the provider executes the tool and inlines
 * the result in the response.
 *
 * V1 coverage:
 *   - **Anthropic**: `web_search`, `code_execution`, `web_fetch`.
 *   - **Gemini**: `web_search` (Google Search), `code_execution`,
 *     `url_context`.
 *   - **OpenAI / DeepSeek / Ollama**: throw — OpenAI's server tools
 *     live on the Responses API (separate slice); the compat
 *     providers don't expose them.
 *
 * Cross-provider portability:
 *   - `web_search` + `code_execution` work on both Anthropic and
 *     Gemini.
 *   - `web_fetch` is Anthropic-only.
 *   - `url_context` is Gemini-only.
 *
 * Server tools combine freely with framework-local `Tool[]` and
 * MCP servers — the model sees all three sets in one tool list.
 */
export type ServerTool =
  | {
      type: 'web_search'
      /** Max times the model can call this tool per turn (Anthropic; Gemini ignores). */
      maxUses?: number
      /** Domain allowlist (Anthropic; Gemini ignores). Mutually exclusive with `blockedDomains`. */
      allowedDomains?: readonly string[]
      /** Domain blocklist (Anthropic; Gemini ignores). */
      blockedDomains?: readonly string[]
    }
  | { type: 'code_execution' }
  | {
      type: 'web_fetch'
      /** Max URL fetches per turn (Anthropic). */
      maxUses?: number
      /** Domain allowlist. */
      allowedDomains?: readonly string[]
      /** Domain blocklist. */
      blockedDomains?: readonly string[]
    }
  | {
      type: 'url_context'
      /** Gemini fetches the URL and surfaces grounded answers from it. */
    }

/**
 * Per-call compaction configuration. Maps to Anthropic's
 * `compact-2026-01-12` beta `edits[]` entry. All fields optional —
 * omitting one falls back to the server's default (trigger:
 * 150,000 input tokens; no extra instructions; no pause).
 */
export interface CompactConfig {
  /**
   * Trigger threshold in input tokens. Compaction fires once the
   * conversation crosses this token count. Default 150,000 — same
   * as the server-side default.
   */
  trigger?: number
  /**
   * Extra hint to the summarization model. Useful for biasing the
   * compaction toward what your app actually cares to preserve
   * ("keep all customer ids referenced", "preserve every diff
   * hunk", ...).
   */
  instructions?: string
  /**
   * When `true`, the server returns the compaction block in-line
   * but does NOT continue generation — the next assistant turn
   * waits for an explicit re-prompt. Apps that want to inspect or
   * gate compaction set this; default `false` (compaction is
   * transparent).
   */
  pauseAfterCompaction?: boolean
}

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
  /**
   * Server-side tools — work the provider's backend runs (web
   * search, code execution, URL fetching). The model's calls
   * don't round-trip through the framework's tool loop; results
   * land inline in the response. Combines freely with
   * framework-local `Tool[]` and MCP servers.
   *
   * V1 supports Anthropic + Gemini; OpenAI / DeepSeek / Ollama
   * throw `BrainError` (use the Responses API for OpenAI, or
   * route to Anthropic / Gemini).
   */
  serverTools?: readonly ServerTool[]
  /**
   * Server-side conversation compaction. When set, the provider
   * auto-summarizes the older part of the message history once the
   * `trigger` token threshold is reached; the summary lives on the
   * response as a `CompactionBlock` that apps round-trip on
   * subsequent requests (Thread does this automatically). Saves
   * tokens on long threads without lossy client-side pruning.
   *
   * Only honored by `AnthropicProvider` (driver `'anthropic'`),
   * via the `compact-2026-01-12` beta. Silently ignored by every
   * other provider so apps targeting multiple providers with the
   * same options object don't have to special-case.
   */
  compact?: CompactConfig
  /**
   * Stateful conversation pointer — OpenAI Responses API. When set,
   * the provider sends only the new turn(s); the server picks up
   * from the prior `Response` identified by this id and replays
   * the conversation server-side. Saves tokens on long threads.
   *
   * Only honored by `OpenAIResponsesProvider` (driver
   * `'openai-responses'`); silently ignored by every other provider
   * — apps that target multiple providers with the same options
   * object don't have to special-case.
   *
   * Pair with `ChatResult.responseId` (returned by every call) to
   * thread the conversation forward. `Thread` does this
   * automatically when its underlying provider supports it.
   */
  previousResponseId?: string
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
  /**
   * Structured assistant content blocks — populated when the model
   * emitted more than plain text on this turn (compaction blocks
   * today; reasoning blocks once those surface). Apps that
   * persist the conversation (`Thread`, custom stores) push this
   * onto the message history when present so round-trippable
   * blocks survive subsequent requests. Undefined when the turn
   * was plain text only.
   */
  content?: ContentBlock[]
  /**
   * Provider response id when the provider exposes stateful
   * conversations (currently OpenAI Responses API). Apps thread
   * this forward via `ChatOptions.previousResponseId` so the
   * server replays prior turns without re-sending them.
   * Undefined for providers that don't support the pattern.
   */
  responseId?: string
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
 * Per-call options for `brain.embed(...)`. Only the embed-relevant
 * subset of `ChatOptions` — chat-specific knobs (system prompt,
 * thinking, cache, tools) don't apply.
 */
export interface EmbedOptions {
  /** Override the configured default embedding model. */
  model?: string
  /**
   * Override the default provider. Must name a provider that
   * implements `embed` (V1: OpenAI, Gemini, Ollama; Anthropic +
   * DeepSeek throw with a clear "route to a different provider"
   * message).
   */
  provider?: string
  /**
   * Optional dimensionality hint. OpenAI passes through as
   * `dimensions`; Gemini as `outputDimensionality`. Providers
   * that ignore it silently drop the field.
   */
  dimensions?: number
  /** Cancellation signal — same shape as `ChatOptions.signal`. */
  signal?: AbortSignal
}

/**
 * Per-call options for `brain.transcribe(...)`.
 */
export interface TranscribeOptions {
  /** Override the configured default transcription model. */
  model?: string
  /**
   * Override the default provider. Must name a provider that
   * implements `transcribe` (V1: OpenAI / Gemini / Ollama;
   * Anthropic + DeepSeek throw).
   */
  provider?: string
  /**
   * Optional BCP-47 language hint (`en`, `fr`, `ja`). Improves
   * accuracy when known; models without hint support ignore.
   */
  language?: string
  /**
   * Optional bias prompt to steer vocabulary / style / formatting.
   * OpenAI calls this `prompt`; Gemini-via-chat threads it into
   * the system message; others ignore.
   */
  prompt?: string
  /** Cancellation signal — same shape as `ChatOptions.signal`. */
  signal?: AbortSignal
}

/**
 * Audio source — same discriminated union as
 * `AudioBlock.source`, named separately for `transcribe(...)`
 * which takes it directly (no wrapping `AudioBlock` shell).
 */
export type AudioSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }

/**
 * Result of one `transcribe` call. `text` is the transcribed
 * audio; `language` / `duration` are surfaced when the provider
 * returns them (OpenAI does on the `verbose_json` response
 * format; Gemini's chat-wrap path doesn't). `raw` is the
 * provider's full native response for fields the framework
 * doesn't surface.
 */
export interface TranscribeResult<Raw = unknown> {
  text: string
  model: string
  /** BCP-47 detected (or echoed) language. Optional. */
  language?: string
  /** Audio duration in seconds. Optional. */
  duration?: number
  raw: Raw
}

/**
 * Result of one `embed` call. `embeddings[i]` is the vector for
 * the i-th input text. `model` is the model the provider used
 * (echoed back for logging). `usage.inputTokens` is the total
 * tokens consumed across all inputs.
 */
export interface EmbedResult<Raw = unknown> {
  embeddings: number[][]
  model: string
  usage: { inputTokens: number }
  /** Provider's full native response — escape hatch for fields the framework doesn't surface. */
  raw: Raw
}

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
  /** See `ChatResult.responseId`. */
  responseId?: string
}
