# @strav/brain — API Reference

> **Status:** Reflects brain foundation (M5.3) + tools / agents slice. Anthropic provider, manager, thread, prompt caching, tools, agents. MCP / embeddings / other providers / structured outputs / streaming agents in follow-up slices.

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
  OpenAIProvider,
  GeminiProvider,
  // Config
  type BrainConfigShape,
  type AnthropicProviderConfig,
  type OpenAIProviderConfig,
  type GeminiProviderConfig,
  type ProviderConfig,
  type BrainCacheConfig,
  DEFAULT_TIERS,
  DEFAULT_MODEL,
  // Conversation
  Thread,
  type ThreadOptions,
  type ThreadState,
  // Tools + agents
  Agent,
  AgentRunner,
  type AgentRunResult,
  type AgentResolver,
  type AgentResult,
  type AgentGenerateResult,
  type AgentStreamEvent,
  defineTool,
  type DefineToolSpec,
  type Tool,
  type ToolContext,
  type RunWithToolsOptions,
  ToolExecutionError,
  // MCP
  type MCPServer,
  type MCPServerToolConfig,
  // Structured outputs
  type OutputSchema,
  type GenerateResult,
  // Shapes
  type Message,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type MCPToolUseBlock,
  type MCPToolResultBlock,
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
  generate<T>(
    input: string | readonly Message[],
    schema: OutputSchema<T>,
    options?: ChatOptions,
  ): Promise<GenerateResult<T>>
  runTools(input: string | readonly Message[], tools: readonly Tool[], options?: RunWithToolsOptions): Promise<AgentResult>
  streamTools(input: string | readonly Message[], tools: readonly Tool[], options?: RunWithToolsOptions): AsyncIterable<AgentStreamEvent>
  generateWithTools<T>(
    input: string | readonly Message[],
    schema: OutputSchema<T>,
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>>
  streamGenerateWithTools<T>(
    input: string | readonly Message[],
    schema: OutputSchema<T>,
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<T>>
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

`generate` returns a parsed object shaped to the supplied `OutputSchema<T>`. Throws `BrainError` when the configured provider lacks `generate`, when the response isn't valid JSON, or when `schema.parse` rejects. See [`guides/structured-outputs.md`](./guides/structured-outputs.md) for full coverage.

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
  runWithTools?(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): Promise<AgentResult>
  streamWithTools?(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent>
  generate?<T>(
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options?: ChatOptions,
  ): Promise<GenerateResult<T>>
  runWithToolsAndSchema?<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>>
  streamWithToolsAndSchema?<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<T>>
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

## `OpenAIProvider`

Concrete `Provider` backed by `openai` (chat-completions API).

```ts
class OpenAIProvider implements Provider {
  readonly name: string

  constructor(
    name: string,
    config: OpenAIProviderConfig,
    options?: { client?: OpenAI },
  )

  // …implements Provider (except countTokens — not implemented for OpenAI)
}
```

Maps framework shapes to OpenAI's wire format:

| Framework | OpenAI SDK |
|---|---|
| `options.system: string` | first message: `{ role: 'system', content: string }` |
| `options.system: { text, cache }` | `{ role: 'system', content: text }` (cache silently dropped — OpenAI auto-caches) |
| `options.system: array` | joined with newlines |
| Assistant `message.content` with `ToolUseBlock`s | `{ role: 'assistant', content?, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }` |
| User `message.content` with `ToolResultBlock`s | one `{ role: 'tool', tool_call_id, content }` message per result (fan-out) |
| `Tool[]` | `[{ type: 'function', function: { name, description, parameters: inputSchema } }]` |
| `options.thinking: 'adaptive'` | `reasoning_effort: 'medium'` |
| `options.thinking: 'disabled'` | `reasoning_effort: 'minimal'` |
| `options.effort` | `reasoning_effort` (overrides `thinking` mapping) |
| `options.maxTokens` | `max_completion_tokens` |
| `options.cache: true` | silently no-op (OpenAI prompt cache is automatic) |
| `options.mcpServers` (non-empty) | resolved via the local MCP client (`@strav/brain/mcp`); discovered tools merged into the loop with names `<server>__<tool>` |

Streaming adds `stream_options: { include_usage: true }` so the terminal `stop` event carries final usage including `cacheReadTokens` (from `prompt_tokens_details.cached_tokens`). `countTokens` is not implemented — `BrainManager.countTokens` returns `null` when routed to OpenAI.

## `GeminiProvider`

Concrete `Provider` backed by `@google/genai` (Gemini Developer API; Vertex via SDK config).

```ts
class GeminiProvider implements Provider {
  readonly name: string

  constructor(
    name: string,
    config: GeminiProviderConfig,
    options?: { client?: { models: GeminiModelsClient } },
  )

  // …implements Provider, including countTokens (Gemini has a dedicated endpoint)
}
```

Maps framework shapes to Gemini's wire format:

| Framework | Gemini SDK |
|---|---|
| Role `'assistant'` | `'model'` |
| `options.system` (any shape) | `config.systemInstruction` (multi-block joined with newlines) |
| `Message.content: string` | `Content.parts: [{ text }]` |
| `TextBlock` | `{ text }` part |
| `ToolUseBlock` (assistant) | `{ functionCall: { id, name, args } }` part |
| `ToolResultBlock` (user) | `{ functionResponse: { id, name, response: { result \| error } } }` part |
| `Tool[]` | `config.tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema: inputSchema }] }]` |
| `options.thinking: 'adaptive'` | `thinkingConfig: { thinkingBudget: -1 }` |
| `options.thinking: 'disabled'` | `thinkingConfig: { thinkingBudget: 0 }` |
| `options.effort: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `thinkingConfig: { thinkingLevel: 'LOW' \| 'MEDIUM' \| 'HIGH' \| 'HIGH' \| 'HIGH' }` |
| `options.maxTokens` | `config.maxOutputTokens` |
| `options.cache: true` | silently no-op (Gemini prompt cache uses the separate `Caches` API) |
| `options.mcpServers` (non-empty) | resolved via the local MCP client (`@strav/brain/mcp`); discovered tools merged into the loop with names `<server>__<tool>` |

`stream()` iterates `generateContentStream` yielding text deltas; the terminal `stop` event carries the last `usageMetadata` translated to `ChatUsage` (including `cachedContentTokenCount` → `cacheReadTokens`). `countTokens` calls `ai.models.countTokens` and returns `totalTokens`. MCP servers are not supported by Gemini server-side — the local client path is the only option.

## Config

```ts
interface BrainConfigShape {
  default: string
  providers: Record<string, ProviderConfig>
  tiers?: Partial<Record<ModelTier, string>>
  cache?: BrainCacheConfig
}

type ProviderConfig = AnthropicProviderConfig | OpenAIProviderConfig | GeminiProviderConfig // DeepSeek follows

interface AnthropicProviderConfig {
  driver: 'anthropic'
  apiKey: string
  baseUrl?: string
  defaultModel?: string
  defaultMaxTokens?: number
  betas?: readonly string[]
}

interface OpenAIProviderConfig {
  driver: 'openai'
  apiKey: string
  baseUrl?: string
  organization?: string
  defaultModel?: string         // defaults to 'gpt-5'
  defaultMaxTokens?: number
}

interface GeminiProviderConfig {
  driver: 'google'
  apiKey: string
  baseUrl?: string
  apiVersion?: string           // 'v1' | 'v1beta'
  defaultModel?: string         // defaults to 'gemini-2.5-flash'
  defaultMaxTokens?: number
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
  signal?: AbortSignal
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
| `signal` | `AbortSignal` for cancellation. Forwarded to the provider SDK; checked between tool-loop iterations; propagated into `ToolContext.signal` so tools can pass it on. See [`guides/cancellation.md`](./guides/cancellation.md). |

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

---

## Tools and agents

### `Tool<TInput, TOutput>`

```ts
interface Tool<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  inputSchema: Record<string, unknown>           // JSON Schema
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}

interface ToolContext {
  readonly callId: string                          // matches ToolUseBlock.id
  readonly context: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal                    // forwarded from options.signal
}
```

The framework-native shape. Providers translate `name`, `description`, and `inputSchema` into their wire format; `execute` runs in your process when the model calls the tool. `inputSchema` is plain JSON Schema — the framework deliberately doesn't couple to Zod so apps stay free to bring whatever validator they want.

### `defineTool(spec)`

```ts
function defineTool<TInput = unknown, TOutput = unknown>(
  spec: DefineToolSpec<TInput, TOutput>,
): Tool<TInput, TOutput>
```

Factory that returns a `Tool`. Mirrors `defineSchema` / `defineWorkflow` / `defineMachine` / `defineDurable`. Generics are inferred from `execute`'s first arg + return type when not specified.

### `RunWithToolsOptions`

```ts
interface RunWithToolsOptions extends ChatOptions {
  maxIterations?: number                         // default 10
  context?: Record<string, unknown>              // passed to every tool's execute(_, ctx).context
}
```

Extends `ChatOptions`. Use `maxIterations` as a safety net; use `context` to thread per-request data (user id, tenant id, trace id) into tool execution without putting it in the prompt.

### `AgentResult`

```ts
interface AgentResult {
  text: string                                   // final assistant text
  messages: Message[]                            // full conversation including tool_use / tool_result blocks
  iterations: number                             // 0 when the model answered without tools
  stopReason: string                             // 'end_turn' on success; 'max_iterations' on ceiling hit
  usage: ChatUsage                               // summed across every model call in the loop
}
```

What `BrainManager.runTools` and `AgentRunner.run` return. `messages` is the audit trail — render it in UIs that want to show users which tools the agent called.

### `BrainManager.runTools(input, tools, options?)`

```ts
brain.runTools(
  input: string | readonly Message[],
  tools: readonly Tool[],
  options?: RunWithToolsOptions,
): Promise<AgentResult>
```

The agentic loop. Send → detect `tool_use` → execute → append `tool_result` → re-send, until the model returns `end_turn` or `maxIterations` is hit.

Throws `BrainError` when the configured provider doesn't implement `runWithTools` (V1: `AnthropicProvider`, `OpenAIProvider`, `GeminiProvider`; DeepSeek follows). Throws `ToolExecutionError` when a tool's `execute` throws — the loop aborts on the first failure in V1. `OpenAIProvider` and `GeminiProvider` resolve `mcpServers` through the local MCP client at `@strav/brain/mcp` and surface discovered tools to the loop.

### `BrainManager.streamTools(input, tools, options?)`

```ts
brain.streamTools(
  input: string | readonly Message[],
  tools: readonly Tool[],
  options?: RunWithToolsOptions,
): AsyncIterable<AgentStreamEvent>
```

Streaming twin of `runTools`. Yields `AgentStreamEvent`s as the loop progresses — text deltas, tool boundaries, per-iteration markers, terminal `stop`. Same provider routing, tier resolution, MCP handling, and `maxIterations` ceiling as `runTools`. Throws `BrainError` when the configured provider lacks `streamWithTools` (V1: all three providers implement it).

```ts
type AgentStreamEvent<T = never> =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'iteration_end'; iteration: number; stopReason: string | null }
  // stop narrows when T is set (schema-constrained streams):
  | { type: 'stop'; stopReason: string; iterations: number; usage: ChatUsage; messages: Message[] }       // T = never
  | { type: 'stop'; stopReason: string; iterations: number; usage: ChatUsage; messages: Message[]; value: T; text: string }  // T set
```

See [`guides/streaming-agents.md`](./guides/streaming-agents.md) for the event lifecycle, error handling, and per-provider mapping.

### `BrainManager.generateWithTools(input, schema, tools, options?)`

```ts
brain.generateWithTools<T>(
  input: string | readonly Message[],
  schema: OutputSchema<T>,
  tools: readonly Tool[],
  options?: RunWithToolsOptions,
): Promise<AgentGenerateResult<T>>
```

Combined tool-loop + structured output. Runs the agentic loop with `tools` while pinning the output to `schema` on every turn; returns the parsed value when the model finally answers without calling a tool. Throws `BrainError` when the configured provider lacks `runWithToolsAndSchema` (V1: all three providers implement it).

Per-provider mapping: Anthropic adds `output_config.format`; OpenAI adds `response_format.json_schema` with `strict: true`; Gemini adds `responseMimeType: 'application/json'` + `responseJsonSchema`. The model can still emit `tool_use` blocks during the loop — the schema only kicks in on the terminal text turn.

### `BrainManager.streamGenerateWithTools(input, schema, tools, options?)`

```ts
brain.streamGenerateWithTools<T>(
  input: string | readonly Message[],
  schema: OutputSchema<T>,
  tools: readonly Tool[],
  options?: RunWithToolsOptions,
): AsyncIterable<AgentStreamEvent<T>>
```

Streaming twin of `generateWithTools`. Yields the standard `AgentStreamEvent<T>` vocabulary; the terminal `stop` event narrows to include `value: T` + `text: string` — the parsed JSON shaped to the schema and the raw JSON the model emitted on its terminal turn. Throws `BrainError` when the provider lacks `streamWithToolsAndSchema` (V1: all three providers implement it).

### `Agent`

```ts
abstract class Agent {
  abstract readonly instructions: string         // system prompt
  readonly tools: readonly Tool[]                // default []
  readonly provider?: string                     // overrides default provider routing
  readonly model?: string                        // explicit model wins over tier
  readonly tier: ModelTier                       // default 'powerful' (claude-opus-4-7)
  readonly maxIterations: number                 // default 10
  readonly maxTokens: number                     // default 4096
}
```

Subclass with `@inject()` to get container DI. `BrainProvider` installs an `AgentResolver` so `brain.agent(MyAgent)` resolves through `app.resolve(MyAgent)` — i.e. constructor injection works normally.

### `AgentRunner`

```ts
class AgentRunner<T = never> {
  input(text: string): this                      // required before run() / stream()
  context(data: Record<string, unknown>): this   // accumulating; per-call > thread defaults
  output<U>(schema: OutputSchema<U>): AgentRunner<U>  // switches to structured-output mode
  run(): Promise<AgentRunResult<T>>
  stream(): AsyncIterable<AgentStreamEvent<T>>   // typed stop when T is set via .output()
}

type AgentRunResult<T> = [T] extends [never] ? AgentResult : AgentGenerateResult<T>
```

Returned by `BrainManager.agent(Class)`. Designed to chain:

```ts
const result = await brain.agent(ResearchAgent)
  .input('What is the current state of X?')
  .context({ userId: '...', tenantId: '...' })
  .run()
//  ^? AgentResult

const { value } = await brain.agent(CityAgent)
  .input('Capital of France?')
  .output(citySchema)
  .run()
//  ^? AgentGenerateResult<CityAnswer>
```

`.output(schema)` switches the runner into structured-output mode — `run()` delegates to either `BrainManager.generate(...)` (no tools / mcpServers) or `BrainManager.generateWithTools(...)` (tools or mcpServers declared) and returns `AgentGenerateResult<T>`. The combined path runs the full agentic loop while pinning the schema constraint every turn.

`.stream()` is the streaming twin of `run()`. Returns `AsyncIterable<AgentStreamEvent<T>>` — with the default `T = never` the terminal `stop` event is the plain shape; after `.output(schema)`, `T` narrows and the `stop` event additionally carries `value: T` + raw `text`.

### `AgentGenerateResult<T>`

```ts
interface AgentGenerateResult<T = unknown> {
  value: T
  text: string
  messages: Message[]
  iterations: number           // always 0 in V1 (schema path doesn't engage the tool loop)
  stopReason: string
  usage: ChatUsage
}
```

### `BrainManager.agent(Class, instance?)`

```ts
brain.agent<A extends Agent>(
  AgentClass: new (...args: never[]) => A,
  instance?: A,
): AgentRunner
```

When `instance` is omitted, the registered `AgentResolver` builds one (typically through the container so constructor injection works). Pass `instance` when you need to construct the agent yourself with per-request state.

### `BrainManager.setAgentResolver(resolver)`

```ts
type AgentResolver = <A extends Agent>(cls: new (...args: never[]) => A) => A

brain.setAgentResolver(resolver: AgentResolver): void
```

`BrainProvider.register()` calls this at boot with a resolver wired to `app.resolve(cls)`. Apps building a `BrainManager` by hand (tests) can omit it — `brain.agent(Class)` will fall back to zero-arg construction.

### `ToolExecutionError`

```ts
class ToolExecutionError extends StravError {
  code = 'brain.tool-execution-failed'
  status = 500
  context: { tool: string; callId: string }
  cause: unknown                                 // the tool's original throw
}
```

Thrown by `runWithTools` when a tool's `execute` throws OR when the model calls an unregistered tool. V1 propagates this out of the loop — apps that want the model to recover gracefully catch the error, append a synthetic `tool_result` with `isError: true`, and re-call the runner.

### `ToolUseBlock` / `ToolResultBlock`

```ts
interface ToolUseBlock {
  type: 'tool_use'
  id: string                                     // provider-assigned call id
  name: string                                   // matches Tool.name
  input: unknown                                 // model's parsed JSON
}

interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string                              // matches the ToolUseBlock.id
  content: string | TextBlock[]
  isError?: boolean
}
```

Content-block variants for tool calls + results. Appear in `assistant`-role messages (tool_use) and `user`-role messages (tool_result). Translated to the provider's wire format on send.

---

## MCP (Model Context Protocol)

`@strav/brain` supports MCP through two paths:

- **Anthropic — server-side connector.** Apps declare server URLs; Anthropic's backend handles tool discovery and invocation; `MCPToolUseBlock` / `MCPToolResultBlock` blocks appear inline in the response.
- **OpenAI (and future Gemini / DeepSeek) — local MCP client at `@strav/brain/mcp`.** The provider dials each server itself via Streamable HTTP, discovers its tools, and surfaces them to the agentic loop as ordinary `Tool`s named `<server>__<tool>`. No `mcp_tool_use` blocks — these tools flow through the standard `tool_use` / `tool_result` path.

Both paths consume the same `MCPServer` config, so apps switch providers without rewriting their server declarations.

### `MCPServer`

```ts
interface MCPServer {
  name: string                                 // identifier; matches MCPToolUseBlock.serverName
  url: string                                  // HTTPS URL of the MCP server
  authorizationToken?: string                  // optional bearer token
  tools?: MCPServerToolConfig
}

interface MCPServerToolConfig {
  allowedTools?: readonly string[]             // whitelist of tool names; omit for "all"
  enabled?: boolean                            // default true; false declares-but-disables
}
```

### Declaring MCP servers

Three places, in increasing specificity. Each overrides (replaces, doesn't merge) the broader one:

| Where | When |
|---|---|
| `config.brain.mcpServers` | App-wide default. Used on every `runTools` call unless overridden |
| `Agent.mcpServers` | Per-agent. The agent always uses this list, regardless of app-level default |
| `RunWithToolsOptions.mcpServers` | Per-call. Dynamic — e.g. when each user has their own MCP credentials |

Passing `mcpServers: []` per-call opts out — the call sees no MCP servers regardless of the app-level default.

### `MCPToolUseBlock`

```ts
interface MCPToolUseBlock {
  type: 'mcp_tool_use'
  id: string
  serverName: string                           // matches MCPServer.name
  name: string                                 // tool name as exposed by the MCP server
  input: unknown
}
```

Read-only. Appears in `assistant`-role messages when the model called an MCP tool. The framework surfaces this for observability (rendering "the agent consulted Linear" in UIs); it never echoes the block back to the model — Anthropic's backend tracks MCP state on its side.

### `MCPToolResultBlock`

```ts
interface MCPToolResultBlock {
  type: 'mcp_tool_result'
  toolUseId: string                            // matches MCPToolUseBlock.id
  content: string | TextBlock[]
  isError?: boolean                            // true when the MCP server returned an error
}
```

Same pattern — read-only. Apps that want to alert on MCP errors filter for `isError: true`.

### Beta header

When `mcpServers` is non-empty on the Anthropic path, the provider switches to `client.beta.messages.create` and adds the `mcp-client-2025-11-20` beta header automatically. Apps don't need to manage this — it's part of the provider's translation.

---

## `@strav/brain/mcp` — local MCP client

Sub-path export. Used internally by providers without server-side MCP (OpenAI today; Gemini / DeepSeek as they land). Exposed for apps that want lower-level access — listing tools without running the loop, or sharing connections across requests.

### `MCPClient`

```ts
class MCPClient {
  constructor(server: MCPServer, options?: { client?: Client })
  connect(): Promise<void>
  listTools(): Promise<MCPToolDescriptor[]>
  callTool(name: string, input: unknown): Promise<MCPCallToolResult>
  close(): Promise<void>
}

interface MCPToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface MCPCallToolResult {
  content: string
  isError: boolean
}
```

Thin wrapper over `@modelcontextprotocol/sdk`'s `Client` using Streamable HTTP transport. `authorizationToken` from `MCPServer` becomes `Authorization: Bearer <token>`. `connect()` is idempotent; `listTools` / `callTool` auto-connect on first call. SDK-level failures wrap as `BrainError` with the underlying cause preserved.

### `resolveMcpTools`

```ts
function resolveMcpTools(
  servers: readonly MCPServer[],
  options?: { clientFactory?(server: MCPServer): MCPClient },
): Promise<{ tools: Tool[]; close(): Promise<void> }>
```

Discovers tools across a list of servers and returns them as framework `Tool[]`. Honors `MCPServerToolConfig.enabled` and `allowedTools`. Tool names are namespaced `<server>__<tool>` so multiple servers can coexist; the framework strips the prefix before forwarding the call. The returned `close()` shuts down every transport in parallel — providers call it from a `finally`.

---

## Structured outputs

### `OutputSchema<T>`

```ts
interface OutputSchema<T = unknown> {
  name: string                              // identifier — appears in OpenAI's wire format + logs
  description?: string                      // optional hint shown to the model
  jsonSchema: Record<string, unknown>       // JSON Schema (draft 2020-12)
  parse?(value: unknown): T                 // optional runtime validator
}
```

Plain JSON Schema by design — the framework doesn't depend on Zod. Apps that use Zod combine `zod-to-json-schema` with `parse: z.parse` at the call site, or use the `@strav/brain/zod` sub-path helpers (see below).

### `GenerateResult<T>`

```ts
interface GenerateResult<T, Raw = unknown> {
  value: T                  // parsed JSON, optionally run through schema.parse
  text: string              // raw JSON string the model produced
  model: string
  stopReason: string | null
  usage: ChatUsage
  raw: Raw                  // provider's native response
}
```

### Per-provider mapping

| Provider | Wire |
|---|---|
| Anthropic | `output_config: { format: { type: 'json_schema', schema } }` |
| OpenAI | `response_format: { type: 'json_schema', json_schema: { name, description?, schema, strict: true } }` |
| Gemini | `config: { responseMimeType: 'application/json', responseJsonSchema: schema }` |

`BrainManager.generate` throws `BrainError` when: the provider lacks `generate`; the response isn't valid JSON; or `schema.parse` rejects. Parse failures attach the raw text to `BrainError.context.text` for inspection.

---

## `@strav/brain/zod` — Zod helpers (optional)

Sub-path export. Opt-in helpers for apps that already use Zod. `zod` is an **optional peer dependency** — apps that don't import this path don't install it, don't bundle it.

### `outputSchema`

```ts
function outputSchema<T>(
  schema: z.ZodType<T>,
  options?: { name?: string; description?: string },
): OutputSchema<T>
```

Returns an `OutputSchema<T>` whose `jsonSchema` is derived via `z.toJSONSchema` and whose `parse` runs `schema.parse`. `description` defaults to the schema's `.describe(...)` text; `name` defaults to `'output'`.

### `tool`

```ts
function tool<TInput, TOutput>(spec: {
  name: string
  description: string
  input: z.ZodType<TInput>
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}): Tool<TInput, TOutput>
```

Returns a framework `Tool` whose `inputSchema` is `z.toJSONSchema(spec.input)`. The wrapper validates the model's raw input through `spec.input.parse` before delegating to `execute`, so the function body sees an already-typed value. Validation errors propagate as `ZodError` and the agentic loop wraps them into `ToolExecutionError`.

See [`guides/zod.md`](./guides/zod.md) for full coverage.
