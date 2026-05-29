# @strav/brain

The AI module for Strav 1.0 — a unified `Provider` interface, a per-app `BrainManager` facade, multi-turn `Thread`s, and built-in prompt caching. V1 ships **five** providers: **Anthropic** (`@anthropic-ai/sdk`), **OpenAI** (`openai`), **Gemini** (`@google/genai`), **DeepSeek** (OpenAI-compat subclass), and **Ollama** (OpenAI-compat subclass for local + open-weights models — privacy / dev / on-prem).

> **Status: 1.0.0-alpha.11 — foundation + tools / agents + MCP + OpenAI provider shipped.**
> Shipping: **`Provider`** interface, **`AnthropicProvider`** (chat / stream / countTokens / **runWithTools** w/ server-side MCP) backed by `@anthropic-ai/sdk`, **`BrainManager`** facade (provider routing, model-tier sugar, default-cache + default-MCP-servers config, single-shot + streaming + token-count surfaces, **`runTools(messages, tools, options)`**, **`agent(Class)` runner**), **`Thread`** (multi-turn with `toJSON` / `fromJSON` persistence), **`BrainProvider`** service provider, **prompt caching**, **adaptive thinking** + **effort** opt-ins, **`defineTool({ name, description, inputSchema, execute })`**, **`Agent`** declarative base class + **`AgentRunner`** fluent builder, **`MCPServer`** config + per-server `tools.allowedTools` / `enabled` knobs, app-level + agent-level + per-call MCP server declaration, **`MCPToolUseBlock`** / **`MCPToolResultBlock`** content types (read-only — Anthropic's backend handles invocation; framework surfaces for observability), automatic switch to `client.beta.messages.create` + `mcp-client-2025-11-20` beta header when MCP servers are in use, **`ToolUseBlock`** / **`ToolResultBlock`** content types, **typed errors** (`BrainError`, `ToolExecutionError`).
> Deferred: **streaming agent loops**, **Anthropic server-side tools** (`code_execution_*`, `web_search_*`), **MCP local client** (`@strav/brain/mcp` sub-path — for OpenAI / Gemini / DeepSeek providers that lack server-side MCP), **MCP OAuth flow** (V1: static bearer tokens only), **embeddings**, **vision / files / batches**, **structured outputs** (`output_config.format` + Zod), **OpenAI / Gemini / DeepSeek providers** (one slice per), **server-side compaction** (`compact-2026-01-12` beta — Thread-level integration), **`generate(schema)`** convenience over `chat`, **graceful tool-error recovery** (V1: throws abort the loop). **Managed Agents** lands as a separate sub-path (`@strav/brain/managed-agents`) when it ships.

## Install

```bash
bun add @strav/brain
```

Peer deps: `@strav/kernel`, `@anthropic-ai/sdk` (^0.100), `openai` (^6.0).

## Minimal example

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
}

// bootstrap/providers.ts
import { ConfigProvider, LoggerProvider } from '@strav/kernel'
import { BrainProvider } from '@strav/brain'
import brainConfig from '../config/brain.ts'

app.useProviders([
  new ConfigProvider({ brain: brainConfig, logger: loggerConfig }),
  new LoggerProvider(),
  new BrainProvider(),
])

// app/services/greeter.ts
import { inject } from '@strav/kernel'
import { BrainManager } from '@strav/brain'

@inject()
export class Greeter {
  constructor(private readonly brain: BrainManager) {}

  async greet(name: string): Promise<string> {
    const { text } = await this.brain.chat(`Greet ${name} warmly in one sentence.`)
    return text
  }
}
```

## What's here

| Symbol | Purpose |
|---|---|
| `BrainManager` | The injected facade. `chat / stream / countTokens` with provider routing + tier sugar |
| `BrainProvider` | `ServiceProvider` that builds the manager from `config.brain` and eager-resolves it at boot |
| `BrainConfigShape` / `AnthropicProviderConfig` / `ProviderConfig` | Config type — `default` + `providers` registry + tier overrides + cache defaults |
| `Provider` | The interface a backend implements — `chat`, `stream`, optional `countTokens` |
| `AnthropicProvider` | Concrete `Provider` wrapping `@anthropic-ai/sdk`. Translates framework shapes ↔ SDK shapes |
| `OpenAIProvider` / `OpenAIProviderConfig` | Concrete `Provider` wrapping `openai`. `chat / stream / runWithTools` mapped to chat-completions; `countTokens` not implemented; server-side MCP rejected (use Anthropic) |
| `Thread` | Multi-turn conversation with append-only `messages` + `send` + `toJSON` / `fromJSON` |
| `Message` / `ContentBlock` / `TextBlock` / `SystemPrompt` | Framework-native shapes — `content` is string or block-list; blocks support a `cache` flag |
| `ChatOptions` | Per-call knobs: `model`, `tier`, `system`, `maxTokens`, `thinking`, `effort`, `cache`, `betas`, `provider` |
| `ChatResult` / `ChatUsage` | Response: `text`, `model`, `stopReason`, `usage` (with cache read/creation counters), `raw` escape hatch |
| `StreamEvent` | Streaming union — `{ type: 'text', delta }` per delta + a terminal `{ type: 'stop', stopReason, usage }` |
| `ModelTier` / `DEFAULT_TIERS` / `DEFAULT_MODEL` | `'fast' | 'balanced' | 'powerful'` → `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`. Apps override via `config.brain.tiers` |
| `BrainError` | Typed `StravError` (`brain.error`, status 500). Provider-native errors propagate verbatim through `.cause` |
| `Tool` / `defineTool` / `ToolContext` | Declarative tool shape. `name`, `description`, `inputSchema` (JSON Schema), `execute(input, ctx)` |
| `ToolUseBlock` / `ToolResultBlock` | Content-block types for tool calls and their results. Translated to the provider's wire format on send |
| `BrainManager.runTools` / `Provider.runWithTools` / `RunWithToolsOptions` | The agentic loop. `runTools(messages, tools, options) → AgentResult` |
| `Agent` / `AgentRunner` / `AgentResult` | Declarative agent base class + fluent `.input().context().run()` builder + result shape (`text`, `messages`, `iterations`, `stopReason`, `usage`) |
| `ToolExecutionError` | Typed `StravError` (`brain.tool-execution-failed`). Wraps the tool's throw with `tool` + `callId` in `context` |
| `MCPServer` / `MCPServerToolConfig` | MCP server config. `name`, `url`, `authorizationToken?`, `tools?: { allowedTools?, enabled? }`. Declare app-wide (`config.brain.mcpServers`), per-agent (`Agent.mcpServers`), or per-call (`options.mcpServers`) |
| `MCPToolUseBlock` / `MCPToolResultBlock` | Read-only content blocks Anthropic emits when the model uses an MCP tool. Surfaced on `result.messages` for observability; framework never echoes them back |

## Defaults

- **Default model:** `claude-opus-4-7`. Per the Anthropic guidance, that's the right pick unless an app explicitly downgrades.
- **Tier sugar:** `'fast' → claude-haiku-4-5`, `'balanced' → claude-sonnet-4-6`, `'powerful' → claude-opus-4-7`. Pass `{ tier: 'balanced' }` in `ChatOptions` to swap without naming a model ID.
- **`max_tokens`:** `4096` by default. Apps that want longer responses pass `{ maxTokens: 16000 }` etc. Above ~16K, use `stream()` to avoid HTTP timeouts.
- **Thinking:** off by default. Pass `{ thinking: 'adaptive' }` to enable Claude's adaptive thinking. `'disabled'` is also an explicit option.
- **Caching:** opt-in. Either flip `config.brain.cache.auto = true` for top-level auto-caching on every call, or pass `{ cache: true }` / `system: { text, cache: true }` per-call.

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/getting-started.md`](./guides/getting-started.md) — wiring `BrainProvider`, picking models, basic chat + streaming.
- [`guides/prompt-caching.md`](./guides/prompt-caching.md) — when to cache, where to place breakpoints, how to verify cache hits via `result.usage`.
- [`guides/threads.md`](./guides/threads.md) — multi-turn conversations, persisting threads with `toJSON` / `fromJSON`, when NOT to use a thread.
- [`guides/tools-and-agents.md`](./guides/tools-and-agents.md) — `defineTool` shape, `BrainManager.runTools` lower-level surface, `Agent` declarative class + `brain.agent(Class)` runner, `ctx.context` for passing per-request identity into tools, `ToolExecutionError` handling.
- [`guides/mcp.md`](./guides/mcp.md) — declaring MCP servers (app / agent / per-call), `allowedTools` whitelist, `enabled` flag, how MCP and local tools coexist, reading `mcp_tool_use` / `mcp_tool_result` blocks for observability, when NOT to use MCP.
- [`guides/openai.md`](./guides/openai.md) — `OpenAIProvider` config, shape translation (system prompts, tool definitions, tool-result fan-out), reasoning-effort mapping, what's not supported (`countTokens`, server-side MCP), tier remapping for OpenAI apps.
- [`guides/gemini.md`](./guides/gemini.md) — `GeminiProvider` config, shape translation (`assistant`→`model`, `systemInstruction`, `functionDeclarations` / `functionCall` / `functionResponse`), `thinkingConfig` mapping, MCP via the local client, tier remapping for Gemini apps.
- [`guides/deepseek.md`](./guides/deepseek.md) — `DeepSeekProvider` config; inherits OpenAI's wire format with three deltas (no `reasoning_effort`, no `response_format.json_schema`, DeepSeek-specific cache field); combined tools+schema deferred; recommended subclassing pattern for other OpenAI-compatible vendors (Groq, Together, …).
- [`guides/ollama.md`](./guides/ollama.md) — `OllamaProvider` for local + open-weights models (Llama 3.2 / Qwen 2.5 / Mistral / …). Privacy-preserving + free dev runs. Works against Ollama, LM Studio, llama.cpp's server, vLLM by overriding `baseUrl`.
- [`guides/structured-outputs.md`](./guides/structured-outputs.md) — `brain.generate(input, schema)`: `OutputSchema<T>` shape, optional `parse` hook for Zod / Ajv, per-provider wire (Anthropic `output_config`, OpenAI `response_format`, Gemini `responseJsonSchema`), error handling, when NOT to use it.
- [`guides/zod.md`](./guides/zod.md) — opt-in `@strav/brain/zod` sub-path: `outputSchema(zSchema)` for `brain.generate(...)`, `tool({ input: zSchema, ... })` for `brain.runTools(...)`. Optional peer dep, zero bundle cost when unused.
- [`guides/streaming-agents.md`](./guides/streaming-agents.md) — `brain.streamTools(...)` + `agent.stream()`: `AgentStreamEvent` vocabulary, lifecycle, per-provider mapping (Anthropic / OpenAI / Gemini all wired), error handling.
- [`guides/cancellation.md`](./guides/cancellation.md) — `options.signal: AbortSignal` on every method; SDK forwarding (Anthropic / OpenAI / Gemini); inter-iteration checks in the agentic loop; `ToolContext.signal` for tools to pass through; MCP forwarding.

## When NOT to use brain

- **Cron-driven background work** that summarizes a known prompt against a known input every time. `@strav/brain` is fine for that, but you might prefer to dispatch a Job (`@strav/queue`) that calls the brain — keeps the inference off the request thread and lets `DatabaseQueue`'s queue-until-commit semantics carry the side effect.
- **Streaming to many browsers from one server.** V1 streams via `AsyncIterable<StreamEvent>` which is great for SSE inside a route handler, but the server is still doing all the inference traffic. For high-concurrency UIs, look at server-side `compact-2026-01-12` (lands in V2) or push streams via a queue → worker.
- **Multi-step orchestrations.** `Thread` is for "user-and-assistant talk back and forth." When you need fan-out, conditional dispatch, or rollback, reach for `@strav/workflow`. Workflow steps can each call `brain.chat(...)`.
