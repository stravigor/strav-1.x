# DeepSeek provider

`@strav/brain` ships a `DeepSeekProvider` backed by the `openai` SDK pointed at DeepSeek's OpenAI-compatible chat completions endpoint. It extends `OpenAICompatProvider` (the shared base for all OpenAI-compat vendors) and only adds DeepSeek-specific defaults + a custom cache-token mapping.

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

DeepSeek's API is 1:1 with OpenAI's `/chat/completions` for the bulk of the surface — system prompts, tool definitions, streaming chunk format, `tool_calls` fan-out, `response_format: json_object`. The inherited `OpenAICompatProvider` handles the standard divergences from `OpenAIProvider`:

- **No `reasoning_effort`** (base class strips it — DeepSeek's API rejects unknown fields). `deepseek-reasoner` emits its own thinking tokens regardless of the absent control field.
- **No `response_format.json_schema`** (base class falls back to `json_object` + schema-in-system-prompt + client-side `parseGenerated`). Validates via `schema.parse` when set.
- **Combined tools + schema** uses the **tool-forcing pattern** — see below.

DeepSeek's own addition on top of the base:

- **`cacheReadTokens`** reads from DeepSeek's `prompt_cache_hit_tokens` extension field when the upstream returns it, falling back to `prompt_tokens_details.cached_tokens` otherwise. The same `ChatUsage` shape your other providers report.

## MCP

DeepSeek has no first-party server-side MCP equivalent to Anthropic's connector. Same pattern as `OpenAIProvider` / `GeminiProvider`: `mcpServers` are resolved through the local MCP client at `@strav/brain/mcp`, discovered tools become namespaced `<server>__<tool>` entries in the agentic loop, transports close in a `finally` once the run exits.

## Combined tools + schema — tool-forcing

OpenAI-compat endpoints (DeepSeek, Ollama, Groq, …) don't support per-turn `json_schema` enforcement the way OpenAI's chat completions does. The framework works around it with **tool-forcing**: a synthetic `respond_with_<schemaName>` function tool whose `parameters` IS the desired schema gets injected into the request. The model uses regular tools as needed, then calls `respond_with_*` exactly once with structured args for its final answer. The framework treats that call as the terminal turn — the args become `result.value`.

```ts
const { value } = await brain.generateWithTools(
  'capital of France?',
  citySchema,           // OutputSchema<{ city: string, population: number }>
  [],
  { provider: 'deepseek' },
)
// value = { city: 'Paris', population: 2102650 }
```

It works alongside regular tools. The model decides ordering — usually it'll call regular tools first to gather context, then end on `respond_with_*`.

Caveats vs OpenAI's `strict: true`:

- **Smaller models** may emit args that don't fully conform to the schema. The framework's `parseGenerated` + the optional `schema.parse` hook catch it at the boundary; apps that want runtime validation set `schema.parse`.
- **Schema features** beyond OpenAI function-calling's subset (recursive refs, advanced keywords) may not be honored. Stick to flat object schemas for best results.
- **Tool-name collision**: if a user tool is already named `respond_with_<schemaName>`, the framework throws `BrainError` at the call site. Rename either the tool or the schema.
- **Model declines to use the tool**: if the model returns plain text instead of calling `respond_with_*`, the framework throws `BrainError`. Apps tighten the system-prompt nudge or simplify the task. Hitting `maxIterations` without the call throws the same way.

## What's NOT supported (yet)

- **`countTokens`** — DeepSeek doesn't expose a count endpoint. `BrainManager.countTokens` returns `null` when routed to DeepSeek. Apps that need a count call a local tokenizer or estimate.

## When to pick DeepSeek

| You want… | Pick |
|---|---|
| Cost-efficient general chat | DeepSeek (`deepseek-chat`) |
| R1-style reasoning with strong math/code performance | DeepSeek (`deepseek-reasoner`) |
| Strict server-side structured-output enforcement | OpenAI / Anthropic / Gemini |
| Structured output via tool-forcing (good for many cases) | DeepSeek / Ollama |
| Server-side MCP | Anthropic |
| `countTokens` before you spend the call | Anthropic / Gemini |

The manager routes per-call: `brain.chat(text, { provider: 'deepseek' })` runs against DeepSeek regardless of the default. A/B comparisons across providers are a one-line decision at the call site.

## Extending the pattern

`DeepSeekProvider` extends `OpenAICompatProvider` — the abstract base that captures the standard OpenAI-compat override set (strip `reasoning_effort`, `json_object`-mode `generate` with schema-in-system-prompt, **tool-forcing for combined tools + schema**, `mapUsage` hook for vendor cache fields). Same base for any OpenAI-compatible vendor (Groq, Together, Fireworks, vLLM, llama.cpp's OpenAI-compat mode):

```ts
import { OpenAICompatProvider } from '@strav/brain'

export class GroqProvider extends OpenAICompatProvider {
  constructor(name: string, config: GroqConfig) {
    super(name, {
      driver: 'openai',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.groq.com/openai/v1',
      defaultModel: config.defaultModel ?? 'llama-3.3-70b-versatile',
    })
  }
  // Override `mapUsage` if Groq reports cache hits on a custom field;
  // override `buildParams` if Groq supports a field the base strips.
}
```

Then register it as a custom driver in `config.brain.providers` (apps that want this wire `BrainProvider` with their own `buildProvider` routine).
