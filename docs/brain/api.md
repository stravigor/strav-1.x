# @strav/brain — API Reference

> **Status:** Reflects the brain foundation slice (M5.3). Anthropic provider, manager, thread, prompt caching. Tools / agents / MCP / embeddings / other providers in follow-up slices.

## Public exports

```ts
import {
  // Manager + service provider
  BrainManager,
  BrainProvider,
  type BrainManagerOptions,
  // Provider interface + impl
  type Provider,
  AnthropicProvider,
  // Config
  type BrainConfigShape,
  type AnthropicProviderConfig,
  type ProviderConfig,
  type BrainCacheConfig,
  DEFAULT_TIERS,
  DEFAULT_MODEL,
  // Conversation
  Thread,
  type ThreadOptions,
  type ThreadState,
  // Shapes
  type Message,
  type ContentBlock,
  type TextBlock,
  type SystemPrompt,
  type ChatOptions,
  type ChatResult,
  type ChatUsage,
  type StreamEvent,
  type ModelTier,
  // Errors
  BrainError,
} from '@strav/brain'
```

## `BrainManager`

The per-app facade. Built once at boot by `BrainProvider` and injected into services.

```ts
class BrainManager {
  readonly defaultProvider: string

  constructor(options: BrainManagerOptions)

  provider(name?: string): Provider

  chat(input: string | readonly Message[], options?: ChatOptions): Promise<ChatResult>
  stream(input: string | readonly Message[], options?: ChatOptions): AsyncIterable<StreamEvent>
  countTokens(input: string | readonly Message[], options?: ChatOptions): Promise<number | null>
}

interface BrainManagerOptions {
  default: string
  providers: Record<string, Provider>
  tiers?: Partial<Record<ModelTier, string>>
  defaultCache?: boolean
}
```

`chat` accepts either a bare prompt string (wrapped as a single `user`-role message) or a typed `Message[]` for multi-turn / pre-built conversations.

`stream` yields `text` events per delta and a single terminal `stop` event with `stopReason` + `usage`. Apps that need the full collected message use `chat` instead.

`countTokens` returns `null` when the configured provider doesn't expose a count helper — apps fall back to a local estimator at the call site.

`provider(name?)` resolves a provider by name (default when omitted). Throws `BrainError` for unknown names.

### Tier sugar

`ChatOptions.tier` is sugar for selecting a model without naming an SDK ID. The manager resolves the tier through `tiers` (constructor) → `config.brain.tiers` → `DEFAULT_TIERS`. Explicit `options.model` wins over `tier`.

```ts
DEFAULT_TIERS = {
  fast:      'claude-haiku-4-5',
  balanced:  'claude-sonnet-4-6',
  powerful:  'claude-opus-4-7',
}
```

### Default cache

`BrainManagerOptions.defaultCache` (or `config.brain.cache.auto`) sets the default for `ChatOptions.cache` when the call site doesn't pass one. Use it when every long request in the app should top-level-cache its prefix.

## `BrainProvider`

```ts
class BrainProvider extends ServiceProvider {
  readonly name = 'brain'
  readonly dependencies = ['config']
}
```

Reads `config.brain`, instantiates every configured provider (today: just Anthropic), binds `BrainManager` as a container singleton. `boot()` force-resolves the manager so a missing API key or unknown driver fails at boot, not on the first call.

Throws `ConfigError` at boot for:
- `config.brain` is missing
- `config.brain.providers` is empty
- `config.brain.default` doesn't name a provider in `config.brain.providers`
- A provider entry has an unknown `driver`
- The Anthropic driver is missing `apiKey`

## `Provider`

```ts
interface Provider {
  readonly name: string
  chat(messages: readonly Message[], options?: ChatOptions): Promise<ChatResult>
  stream(messages: readonly Message[], options?: ChatOptions): AsyncIterable<StreamEvent>
  countTokens?(messages: readonly Message[], options?: ChatOptions): Promise<number>
}
```

The contract every backend implements. Apps don't usually call this directly — they go through `BrainManager`. The interface is exported so apps that need a custom provider (e.g. local Ollama) can implement it without subclassing.

## `AnthropicProvider`

Concrete `Provider` backed by `@anthropic-ai/sdk`.

```ts
class AnthropicProvider implements Provider {
  readonly name: string

  constructor(
    name: string,
    config: AnthropicProviderConfig,
    options?: { client?: Anthropic },
  )

  // …implements Provider
}
```

The `client` option lets tests inject a stub and lets apps that want a pre-configured `Anthropic` instance (custom retries, fetch transport, etc.) hand it over instead of letting the provider build one.

### Request-shape translation

The provider translates framework types into Anthropic SDK params at the request boundary:

| Framework | Anthropic SDK |
|---|---|
| `message.content: string` | `{ role, content: string }` |
| `message.content: TextBlock[]` | `{ role, content: TextBlockParam[] }` |
| `block.cache: true` | `cache_control: { type: 'ephemeral' }` on that block |
| `options.system: string` | `system: string` |
| `options.system: { text, cache }` | `system: [{ type: 'text', text, cache_control? }]` |
| `options.system: array` | `system: [TextBlockParam, …]` |
| `options.thinking: 'adaptive'` | `thinking: { type: 'adaptive' }` |
| `options.thinking: 'disabled'` | `thinking: { type: 'disabled' }` |
| `options.effort: 'high'` | `output_config: { effort: 'high' }` |
| `options.cache: true` | top-level `cache_control: { type: 'ephemeral' }` |
| `options.betas` + provider betas | merged + deduped, sent as `betas` |
| `options.maxTokens` | `max_tokens` |

### Response-shape translation

The SDK's `Anthropic.Message` is collapsed into `ChatResult`:

- `text` is every `text`-type content block concatenated.
- `model` / `stopReason` are passed through.
- `usage` carries the SDK's `input_tokens` / `output_tokens` + `cache_creation_input_tokens` / `cache_read_input_tokens` (`0` when absent).
- `raw` is the unmodified SDK `Message` for apps that need anything else (citations, server-tool results, etc.).

## Config

```ts
interface BrainConfigShape {
  default: string
  providers: Record<string, ProviderConfig>
  tiers?: Partial<Record<ModelTier, string>>
  cache?: BrainCacheConfig
}

type ProviderConfig = AnthropicProviderConfig // OpenAI / Gemini / DeepSeek follow

interface AnthropicProviderConfig {
  driver: 'anthropic'
  apiKey: string
  baseUrl?: string
  defaultModel?: string
  defaultMaxTokens?: number
  betas?: readonly string[]
}

interface BrainCacheConfig {
  auto?: boolean
}
```

Apps point at env vars for credentials:

```ts
// config/brain.ts
import { env } from '@strav/kernel'

export default {
  default: 'anthropic',
  providers: {
    anthropic: {
      driver: 'anthropic',
      apiKey: env('ANTHROPIC_API_KEY'),
      defaultModel: 'claude-opus-4-7',
    },
  },
  tiers: {
    // Override the framework defaults if needed.
    fast: 'claude-haiku-4-5',
  },
  cache: { auto: false },
} satisfies BrainConfigShape
```

## `Thread`

Multi-turn conversation built on `BrainManager.chat`.

```ts
class Thread {
  readonly messages: Message[]
  readonly system?: SystemPrompt
  readonly options?: ChatOptions

  constructor(brain: BrainManager, opts?: ThreadOptions)

  send(text: string, options?: ChatOptions): Promise<string>
  get length(): number

  toJSON(): ThreadState
  static fromJSON(brain: BrainManager, state: ThreadState): Thread
}

interface ThreadOptions {
  system?: SystemPrompt
  options?: ChatOptions
}

interface ThreadState {
  messages: Message[]
  system?: SystemPrompt
  options?: ChatOptions
}
```

**Persistence.** `toJSON()` returns a plain object suitable for `JSON.stringify`. Apps that store conversations in Postgres can serialize the state into a `jsonb` column; rehydrate via `Thread.fromJSON(brain, row.state)` at request time.

**System prompt is thread-owned.** Per-call `options.system` is ignored — the thread's system applies to every turn. This is on purpose: a caller can't drift the conversation mid-thread by silently changing the system prompt every turn.

**Other per-call options merge over thread defaults.** `new Thread(brain, { options: { maxTokens: 500 } })` sets the per-turn default; passing `{ maxTokens: 2000 }` to `send` overrides for that one call.

## Shapes

### `Message`

```ts
interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

type ContentBlock = TextBlock

interface TextBlock {
  type: 'text'
  text: string
  cache?: boolean
}
```

`content` is either a string (no caching) or a typed block list (per-block cache control). System / tool result blocks land in later slices.

### `SystemPrompt`

```ts
type SystemPrompt =
  | string
  | { text: string; cache?: boolean }
  | Array<{ text: string; cache?: boolean }>
```

Plain strings forward as-is. The object form lets apps mark a single system prompt as cacheable; the array form supports multi-block system prompts with mixed cache flags.

### `ChatOptions`

```ts
interface ChatOptions {
  model?: string
  tier?: ModelTier
  system?: SystemPrompt
  maxTokens?: number
  thinking?: 'adaptive' | 'disabled'
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  cache?: boolean
  betas?: readonly string[]
  provider?: string
}
```

| Option | Behavior |
|---|---|
| `model` | Explicit model ID. Wins over `tier`. |
| `tier` | `'fast'` / `'balanced'` / `'powerful'` resolved through `tiers`. |
| `system` | System prompt — string or cache-aware object/array. |
| `maxTokens` | Hard ceiling. Default `4096`. |
| `thinking` | `'adaptive'` on Opus 4.7 / Sonnet 4.6 / Opus 4.6 = the only supported on-mode. `'disabled'` is explicit off. Omitted = off (Opus 4.7 default). |
| `effort` | Adaptive-thinking effort. Maps to `output_config.effort`. |
| `cache` | Sets top-level `cache_control: { type: 'ephemeral' }`. Defaults to `config.brain.cache.auto`. |
| `betas` | Beta headers for this call. Merged with provider-level betas. |
| `provider` | Override the default-provider routing. Must name a provider in the registry. |

### `ChatResult`

```ts
interface ChatResult<Raw = unknown> {
  text: string
  model: string
  stopReason: string | null
  usage: ChatUsage
  raw: Raw
}

interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}
```

`raw` carries the provider's native response — for Anthropic, that's `Anthropic.Message` (citations, server-tool blocks, etc.).

### `StreamEvent`

```ts
type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'stop'; stopReason: string | null; usage: ChatUsage }
```

V1 covers text deltas + final stop. Thinking blocks / tool-use streams reserved for later slices.

## Errors

```ts
class BrainError extends StravError {
  code = 'brain.error'
  status = 500
}
```

The framework's wrapper error. Provider-native errors (e.g. `Anthropic.RateLimitError`) propagate through `.cause` so apps can `instanceof`-check them when they need provider-specific recovery.
