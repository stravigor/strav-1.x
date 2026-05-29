# @strav/brain

The AI module for Strav 1.0 — a unified `Provider` interface, a per-app `BrainManager` facade, multi-turn `Thread`s, and built-in prompt caching. V1 ships the **Anthropic** provider backed by the official `@anthropic-ai/sdk`; OpenAI, Gemini, and DeepSeek follow in later slices.

> **Status: 1.0.0-alpha.8 — M5 slice 3 (brain foundation).**
> Shipping: **`Provider`** interface, **`AnthropicProvider`** (chat / stream / countTokens) backed by `@anthropic-ai/sdk`, **`BrainManager`** facade (provider routing, model-tier sugar, default-cache config, single-shot + streaming + token-count surfaces), **`Thread`** (multi-turn with `toJSON` / `fromJSON` persistence), **`BrainProvider`** service provider (config-driven boot, eager construction so bad config fails at boot), **prompt caching** (top-level + per-block + system-prompt cache flags translate to `cache_control: { type: 'ephemeral' }`), **adaptive thinking** + **effort** opt-ins, **typed `BrainError`** (`brain.error`).
> Deferred: **tools / agents / MCP** (separate slice — wraps the SDK's tool runner + `agent_toolset_20260401`), **embeddings**, **vision / files / batches**, **structured outputs** (`output_config.format` + Zod), **OpenAI / Gemini / DeepSeek providers** (one slice per), **server-side compaction** (`compact-2026-01-12` beta — Thread-level integration), **`generate(schema)`** convenience over `chat`. **Managed Agents** lands as a separate sub-path (`@strav/brain/managed-agents`) when it ships.

## Install

```bash
bun add @strav/brain
```

Peer deps: `@strav/kernel`, `@anthropic-ai/sdk` (the framework pins ^0.100).

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
| `Thread` | Multi-turn conversation with append-only `messages` + `send` + `toJSON` / `fromJSON` |
| `Message` / `ContentBlock` / `TextBlock` / `SystemPrompt` | Framework-native shapes — `content` is string or block-list; blocks support a `cache` flag |
| `ChatOptions` | Per-call knobs: `model`, `tier`, `system`, `maxTokens`, `thinking`, `effort`, `cache`, `betas`, `provider` |
| `ChatResult` / `ChatUsage` | Response: `text`, `model`, `stopReason`, `usage` (with cache read/creation counters), `raw` escape hatch |
| `StreamEvent` | Streaming union — `{ type: 'text', delta }` per delta + a terminal `{ type: 'stop', stopReason, usage }` |
| `ModelTier` / `DEFAULT_TIERS` / `DEFAULT_MODEL` | `'fast' | 'balanced' | 'powerful'` → `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`. Apps override via `config.brain.tiers` |
| `BrainError` | Typed `StravError` (`brain.error`, status 500). Provider-native errors propagate verbatim through `.cause` |

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

## When NOT to use brain

- **Cron-driven background work** that summarizes a known prompt against a known input every time. `@strav/brain` is fine for that, but you might prefer to dispatch a Job (`@strav/queue`) that calls the brain — keeps the inference off the request thread and lets `DatabaseQueue`'s queue-until-commit semantics carry the side effect.
- **Streaming to many browsers from one server.** V1 streams via `AsyncIterable<StreamEvent>` which is great for SSE inside a route handler, but the server is still doing all the inference traffic. For high-concurrency UIs, look at server-side `compact-2026-01-12` (lands in V2) or push streams via a queue → worker.
- **Multi-step orchestrations.** `Thread` is for "user-and-assistant talk back and forth." When you need fan-out, conditional dispatch, or rollback, reach for `@strav/workflow`. Workflow steps can each call `brain.chat(...)`.
