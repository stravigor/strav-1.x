# Gemini provider

`@strav/brain` ships a `GeminiBrainDriver` backed by the official `@google/genai` SDK (Gemini Developer API; Vertex AI also works). Configure it through `config.brain.providers` and call it via the same `BrainManager.chat / stream / runTools / countTokens` surface used by every other driver.

```ts
// config/brain.ts
import { env } from '@strav/kernel'
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'google',
  providers: {
    google: {
      driver: 'google',
      apiKey: env('GOOGLE_API_KEY'),
      defaultModel: 'gemini-2.5-flash',
    },
  },
  tiers: {
    fast: 'gemini-2.5-flash-lite',
    balanced: 'gemini-2.5-flash',
    powerful: 'gemini-2.5-pro',
  },
} satisfies BrainConfigShape
```

Then inject `BrainManager` the same way you would for any other provider:

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
| `driver` | yes | `'google'`. |
| `apiKey` | yes | Source from `env('GOOGLE_API_KEY')` or `env('GEMINI_API_KEY')`. |
| `baseUrl` | no | Optional override of the SDK's HTTP base URL — useful for proxies or test doubles. |
| `apiVersion` | no | Pins the API version (`'v1'`, `'v1beta'`). Defaults to the SDK's pick. |
| `defaultModel` | no | Defaults to `gemini-2.5-flash`. |
| `defaultMaxTokens` | no | Defaults to `4096`. Apps that want longer replies pass `{ maxTokens: 16000 }` per call. |

## What's mapped

The provider hides Gemini's `Content` / `Part` wire format behind the same framework shapes other providers use — `Message[]`, `ContentBlock[]`, `Tool[]`, `ChatResult`, `StreamEvent`. The key translations:

- **Roles.** Framework `assistant` maps to Gemini's `model`. `user` stays `user`. The SDK never sees a `system`-role turn — the system prompt lives on `config.systemInstruction` (see below).
- **System prompts.** Become `config.systemInstruction`. Multi-block system prompts are joined with newlines. Cache flags on system blocks are silently dropped — Gemini's prompt cache is a separate `Caches` API rather than a per-block control, the same shape OpenAI uses.
- **Text content.** String content becomes a single `{ text }` part. `TextBlock[]` content becomes one `{ text }` part per block.
- **Tool definitions.** Each `Tool` becomes one `FunctionDeclaration` under a single `{ functionDeclarations: [...] }` entry in `config.tools`. The framework uses `parametersJsonSchema` (not `parameters`) so your JSON-Schema-shaped tool inputs pass through verbatim — no translation to Gemini's `Schema` shape.
- **Tool calls.** Gemini's `functionCall` parts on a `model` turn become `ToolUseBlock`s in the framework. When Gemini omits the call id, the framework synthesizes one — the id only travels paired with its result and never leaks to the caller.
- **Tool results.** Framework `ToolResultBlock`s on a user turn become `functionResponse` parts. Successful results land under `response.result`; errors (when `isError: true`) land under `response.error`.
- **Thinking.** `{thinking: 'adaptive'}` → `thinkingConfig: { thinkingBudget: -1 }` (auto). `{thinking: 'disabled'}` → `thinkingConfig: { thinkingBudget: 0 }`. An explicit `{effort: 'low' | 'medium' | 'high'}` maps to `thinkingConfig.thinkingLevel` (`xhigh` / `max` cap at `HIGH` — Gemini's enum stops there). Non-thinking models reject `thinkingConfig` upstream when emitted; pick a thinking-capable model (gemini-2.5-*) if you want to use it.
- **Streaming.** `stream()` iterates `generateContentStream`; text deltas yield as `{type: 'text', delta}`. The terminal `{type: 'stop'}` carries the last seen `usageMetadata` translated to `ChatUsage` (including `cachedContentTokenCount` → `cacheReadTokens`).
- **`countTokens`** _is_ implemented. The SDK exposes a dedicated endpoint and `BrainManager.countTokens` returns the total when the configured provider is Gemini — the same surface Anthropic supports.

## MCP

Gemini has no first-party server-side MCP equivalent to Anthropic's connector. The `GeminiBrainDriver` handles `mcpServers` exactly the way `OpenAIBrainDriver` does: it resolves them through the local MCP client at `@strav/brain/mcp`, surfaces the discovered tools as namespaced `<server>__<tool>` entries in the agentic loop, and closes the transports in a `finally` once the run exits.

```ts
const result = await brain.runTools(
  'Summarize my open Linear issues.',
  [],
  {
    mcpServers: [
      { name: 'linear', url: 'https://mcp.linear.app', authorizationToken: env('LINEAR_MCP_TOKEN') },
    ],
  },
)
```

See `docs/brain/guides/mcp.md` for the full local-client behavior.

## What's not supported (yet)

- **Server-side tools** — `googleSearch`, `urlContext`, `codeExecution`, etc. The framework emits only the `functionDeclarations` slot today. Apps that want Google Search grounding reach for it via the `raw` response shape on `ChatResult`.
- **Image / audio / video parts.** The framework currently emits text-only parts; multimodal input lands when the cross-provider content-block work does.
- **Caches API.** `cache: true` is a no-op here. Apps that need explicit prompt caching call the SDK directly via `raw` for now.
- **Vertex AI.** The provider drives the Gemini Developer API by default. Apps that need Vertex configure the SDK directly today; first-class Vertex support is a follow-up.

## Tier mapping

The framework's `DEFAULT_TIERS` is Anthropic-centric. Apps using Gemini typically remap:

```ts
tiers: {
  fast: 'gemini-2.5-flash-lite',
  balanced: 'gemini-2.5-flash',
  powerful: 'gemini-2.5-pro',
}
```

Tiers are per-app, not per-provider. Mixed-provider apps that want unambiguous routing usually pass `model` explicitly instead of `tier`.

## When to pick which provider

| You want… | Pick |
|---|---|
| Server-side MCP with one config line | Anthropic |
| Long context windows on commodity pricing | Gemini |
| Adaptive thinking with `display: 'summarized'` semantics | Anthropic |
| `gpt-5` family specifically | OpenAI |
| `gemini-2.5-pro` reasoning + long context | Gemini |
| Avoid vendor lock-in | Either — keep multiple registered, pass `{ provider: 'google' }` per call |

The manager routes per-call: `brain.chat(text, { provider: 'google' })` runs against Gemini regardless of the default. A/B comparisons across providers are a one-line decision at the call site.
