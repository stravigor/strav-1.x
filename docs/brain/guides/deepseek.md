# DeepSeek provider

`@strav/brain` ships a `DeepSeekProvider` backed by the `openai` SDK pointed at DeepSeek's OpenAI-compatible chat completions endpoint. It inherits from `OpenAIProvider` — the request/response shapes are 1:1 — and overrides only what diverges.

```ts
// config/brain.ts
import { env } from '@strav/kernel'
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'deepseek',
  providers: {
    deepseek: {
      driver: 'deepseek',
      apiKey: env('DEEPSEEK_API_KEY'),
      defaultModel: 'deepseek-chat',
    },
  },
  tiers: {
    fast: 'deepseek-chat',
    balanced: 'deepseek-chat',
    powerful: 'deepseek-reasoner',
  },
} satisfies BrainConfigShape
```

Then inject `BrainManager` the same way you would for any other provider — `brain.chat / stream / runTools / streamTools / generate` work identically.

## Config

| Field | Required | Notes |
|---|---|---|
| `driver` | yes | `'deepseek'`. |
| `apiKey` | yes | Source from `env('DEEPSEEK_API_KEY')`. |
| `baseUrl` | no | Defaults to `https://api.deepseek.com/v1`. Override only for proxies or a private deployment. |
| `defaultModel` | no | Defaults to `deepseek-chat`. Reasoning workloads use `deepseek-reasoner`. |
| `defaultMaxTokens` | no | Defaults to `4096`. |

## What's mapped

DeepSeek's API is 1:1 with OpenAI's `/chat/completions` for the bulk of the surface — system prompts, tool definitions, streaming chunk format, `tool_calls` fan-out, `response_format: json_object`. The provider just inherits OpenAI's translation and changes three things:

- **No `reasoning_effort`.** DeepSeek's API rejects unknown fields. `OpenAIProvider.buildParams` emits `reasoning_effort` when `options.thinking` / `options.effort` is set; `DeepSeekProvider` strips it. `deepseek-reasoner` emits its own thinking tokens regardless of the absent control field — apps that want reasoning use that model.
- **No `response_format.json_schema`.** DeepSeek supports only `response_format.json_object` mode — the model produces JSON but the API doesn't enforce a schema upstream. `generate()` compensates by:
  1. Injecting the JSON Schema into the system prompt with a "respond with JSON matching this schema" instruction.
  2. Setting `response_format: { type: 'json_object' }`.
  3. Parsing the response client-side via `parseGenerated` (which also runs `schema.parse` when set).
- **`cacheReadTokens`** reads from DeepSeek's `prompt_cache_hit_tokens` extension field when the upstream returns it, falling back to `prompt_tokens_details.cached_tokens` otherwise. The same `ChatUsage` shape your other providers report.

## MCP

DeepSeek has no first-party server-side MCP equivalent to Anthropic's connector. Same pattern as `OpenAIProvider` / `GeminiProvider`: `mcpServers` are resolved through the local MCP client at `@strav/brain/mcp`, discovered tools become namespaced `<server>__<tool>` entries in the agentic loop, transports close in a `finally` once the run exits.

## What's NOT supported (yet)

- **`runWithToolsAndSchema` / `streamWithToolsAndSchema`.** Combined tool use + structured output throws `BrainError`. The API's `json_object` mode doesn't carry schema enforcement, and weaving schema-instructions into every turn's system prompt during a tool loop would surprise apps. Run the two as separate calls instead:

  ```ts
  // Gather data
  const { messages } = await brain.runTools(prompt, tools, { provider: 'deepseek' })
  // Summarize into the schema
  const { value } = await brain.generate(messages, summarySchema, { provider: 'deepseek' })
  ```

  Or switch to OpenAI / Anthropic / Gemini for the combined call.
- **`countTokens`** — DeepSeek doesn't expose a count endpoint. `BrainManager.countTokens` returns `null` when routed to DeepSeek. Apps that need a count call a local tokenizer or estimate.

## When to pick DeepSeek

| You want… | Pick |
|---|---|
| Cost-efficient general chat | DeepSeek (`deepseek-chat`) |
| R1-style reasoning with strong math/code performance | DeepSeek (`deepseek-reasoner`) |
| Strict structured-output enforcement | OpenAI / Anthropic / Gemini |
| Server-side MCP | Anthropic |
| `countTokens` before you spend the call | Anthropic / Gemini |

The manager routes per-call: `brain.chat(text, { provider: 'deepseek' })` runs against DeepSeek regardless of the default. A/B comparisons across providers are a one-line decision at the call site.

## Extending the pattern

`DeepSeekProvider extends OpenAIProvider` is the recommended template for any OpenAI-compatible vendor (Groq, Together, Fireworks, vLLM, llama.cpp's OpenAI-compat mode):

```ts
import { OpenAIProvider } from '@strav/brain'

export class GroqProvider extends OpenAIProvider {
  constructor(name: string, config: GroqConfig) {
    super(name, {
      driver: 'openai',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.groq.com/openai/v1',
      defaultModel: config.defaultModel ?? 'llama-3.3-70b-versatile',
    })
  }
  // Override `buildParams` to suppress fields Groq rejects, etc.
}
```

Then register it as a custom driver in `config.brain.providers` (apps that want this can wire `BrainProvider` with their own buildProvider routine).
