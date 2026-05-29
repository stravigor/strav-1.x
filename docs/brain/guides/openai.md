# OpenAI provider

`@strav/brain` ships an `OpenAIProvider` alongside the Anthropic provider. Configure it the same way you'd configure any other driver — through `config.brain.providers` — and call it via the same `BrainManager.chat / stream / runTools` surface.

```ts
// config/brain.ts
import { env } from '@strav/kernel'
export default {
  default: 'openai',
  providers: {
    openai: {
      driver: 'openai',
      apiKey: env('OPENAI_API_KEY'),
      defaultModel: 'gpt-5',
    },
  },
  tiers: {
    fast: 'gpt-5-mini',
    balanced: 'gpt-5',
    powerful: 'gpt-5',
  },
}
```

Then inject `BrainManager` the same way you would for Anthropic:

```ts
@inject()
export class Summarizer {
  constructor(private readonly brain: BrainManager) {}

  async summarize(text: string): Promise<string> {
    const { text: out } = await this.brain.chat(`Summarize:\n\n${text}`, {
      tier: 'balanced',
    })
    return out
  }
}
```

## Config

| Field | Required | Notes |
|---|---|---|
| `driver` | yes | `'openai'`. |
| `apiKey` | yes | Source from `env('OPENAI_API_KEY')`. |
| `baseUrl` | no | Optional override — useful for proxies, Azure OpenAI compatibility, or a stub server in tests. |
| `organization` | no | Optional org id (`org_…`). |
| `defaultModel` | no | Defaults to `gpt-5`. |
| `defaultMaxTokens` | no | Defaults to `4096`. Apps that want longer replies pass `{ maxTokens: 16000 }` per call. |

## What's mapped

The provider hides OpenAI's chat-completions wire format behind the same framework-native shapes you'd use with Anthropic — `Message[]`, `ContentBlock[]`, `Tool[]`, `RunWithToolsOptions`, `ChatResult`, `StreamEvent`. A few translations are worth knowing about:

- **System prompts** become the first message with `role: 'system'`. Multi-block system prompts are joined with newlines. The `cache: true` flag on a system block is silently dropped — OpenAI caches automatically and has no equivalent breakpoint to set.
- **Tool definitions** are wrapped in OpenAI's `function` namespace: `{type: 'function', function: {name, description, parameters: tool.inputSchema}}`. The framework's `defineTool` shape is identical to what Anthropic accepts.
- **Tool calls** in assistant turns become `tool_calls` on a `role: 'assistant'` message, with each call's `arguments` JSON-stringified. The framework keeps `ToolUseBlock`s on `result.messages` so observability code that reads them is provider-agnostic.
- **Tool results** in user turns fan out into one `{role: 'tool', tool_call_id, content}` message per result. OpenAI requires this layout — it does not accept a single user message carrying multiple tool results the way Anthropic does. The framework hides that.
- **Reasoning models.** `{thinking: 'adaptive'}` maps to `reasoning_effort: 'medium'`; `{thinking: 'disabled'}` to `'minimal'`. An explicit `{effort: 'high'}` overrides both. Non-reasoning models silently ignore the field.
- **Streaming.** `stream()` adds `stream_options: { include_usage: true }` so the terminal `stop` event carries final usage data including cached-prompt tokens.

## What's not supported

A few V1 caveats:

- **`countTokens`** is not implemented. OpenAI has no dedicated count endpoint, so `BrainManager.countTokens` returns `null` when the configured provider is OpenAI. Apps that need a count call a local tokenizer (`tiktoken`) or estimate.
- **MCP servers.** OpenAI has no server-side MCP support. Passing a non-empty `mcpServers` array to `runTools` on the OpenAI provider throws a `BrainError`. The local MCP client (`@strav/brain/mcp` sub-path) lands when an OpenAI / Gemini / DeepSeek caller needs it. Use the Anthropic provider for server-side MCP today.
- **Prompt caching flags.** `cache: true` is accepted (so config that targets both providers with one options object doesn't have to special-case) but has no on-wire effect — OpenAI's prompt cache is automatic. Cached tokens still surface on `result.usage.cacheReadTokens` so you can verify hits.

## Tier mapping

The framework's default `DEFAULT_TIERS` map is Anthropic-centric (`claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`). Apps using OpenAI typically remap:

```ts
// config/brain.ts
tiers: {
  fast: 'gpt-5-mini',
  balanced: 'gpt-5',
  powerful: 'gpt-5',
}
```

Tiers are per-app, not per-provider — if you mix providers within one app, the tier→model map is the one resolved on the manager. Apps that mix sometimes prefer to pass `model` explicitly rather than `tier` to keep the choice unambiguous.

## When to pick which provider

| You want… | Pick |
|---|---|
| Server-side MCP | Anthropic |
| `countTokens` before you spend the call | Anthropic |
| Adaptive thinking with explicit `display: 'summarized'` semantics | Anthropic |
| OpenAI's `gpt-5` family specifically | OpenAI |
| To not lock to one vendor | Either — keep both registered, pass `{ provider: 'openai' }` or `{ provider: 'anthropic' }` per call |

The provider routing happens on the manager: `brain.chat(text, { provider: 'openai' })` runs against the OpenAI provider regardless of the default. That makes A/B comparisons or per-feature provider choices a one-line decision at the call site.
