# Ollama provider — local + open-weights models

`@strav/brain` ships an `OllamaProvider` for running inference against a local [Ollama](https://ollama.com) server (or any OpenAI-compatible local-LLM server: LM Studio, llama.cpp's server, vLLM, TGI). Two real use cases this unlocks:

- **Privacy.** Data never leaves the machine / the customer's network — table stakes for regulated workloads (healthcare, finance, on-prem enterprise deployments).
- **Dev / test.** Build agents without burning API credits or needing a cloud key at all. Run the test suite against a local `llama3.2:1b` for free; ship to a hosted provider in prod by switching `config.brain.providers.default`.

## Setup

Install + run Ollama:

```bash
# install (macOS shown; see ollama.com for other OSes)
brew install ollama
ollama serve &                    # daemon listens on :11434

# pull a tool-capable model
ollama pull llama3.2              # 2 GB, fast, supports function calling
ollama pull qwen2.5               # 4.7 GB, stronger reasoning
ollama pull llama3.1:70b          # 40 GB, hosted-tier quality on local hardware
```

Then point Strav at it:

```ts
// config/brain.ts
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'ollama',
  providers: {
    ollama: {
      driver: 'ollama',
      defaultModel: 'llama3.2',          // must be already pulled
    },
  },
} satisfies BrainConfigShape
```

That's it — no API key, no env var. Inject `BrainManager` the same way you would for any other provider; `brain.chat / stream / runTools / streamTools / generate` work identically.

## Config

| Field | Required | Notes |
|---|---|---|
| `driver` | yes | `'ollama'`. |
| `defaultModel` | **yes** | The model must be already pulled on the server (`ollama list` to check). No universal default exists because models are user-installed. |
| `baseUrl` | no | Defaults to `http://localhost:11434/v1`. Override for remote Ollama servers, LM Studio (`:1234/v1`), llama.cpp's server, vLLM, etc. |
| `apiKey` | no | Defaults to `'ollama'` (placeholder; Ollama ignores it). Override only when running behind a proxy that adds its own auth layer. |
| `defaultMaxTokens` | no | Defaults to `4096`. |

## What's mapped

Ollama's OpenAI-compat layer is request/response-shape-identical for the surface the framework uses. `OllamaProvider` extends `OpenAICompatProvider` and inherits the standard OpenAI-compat overrides without adding any of its own:

- **No `reasoning_effort`.** Base class strips the field. Ollama rejects unknown fields; models with built-in thinking (`qwen3-thinking`, `deepseek-r1` distills) emit thinking tokens regardless.
- **No `response_format.json_schema`.** Recent Ollama supports `json_schema` for some models but behavior varies. Base class uses `json_object` + schema-in-system-prompt + client-side `parseGenerated` — works on every tool-capable model.
- **`runWithToolsAndSchema` / `streamWithToolsAndSchema` use tool-forcing.** The framework injects a synthetic `respond_with_<schemaName>` function tool whose `parameters` IS the schema. The model uses regular tools as needed, then calls `respond_with_*` exactly once for its final answer — those args become `result.value`. Caveats and details in [deepseek.md](./deepseek.md#combined-tools--schema--tool-forcing) (the pattern is shared by every OpenAI-compat provider).

## Tool calling

Tool calling depends on the model. As of early 2026, models with reliable tool-calling support:

- **Llama 3.1**, **3.2**, **3.3** — Meta's function-calling-tuned models. `llama3.2` is a good default.
- **Qwen 2.5** — Alibaba's open models. Strong tool use and reasoning.
- **Mistral**, **Mixtral** — Mistral's function-calling models.
- **Granite 3** — IBM's open models with tool calling.

Models without function-calling training (older Llama 2, Phi-2, some specialized fine-tunes) will either ignore tool definitions or return malformed `tool_calls`. If you see `runWithTools` consistently failing, check that your model supports tools.

## MCP

Same pattern as OpenAI / DeepSeek: `mcpServers` are resolved through the local MCP client at `@strav/brain/mcp`, discovered tools become namespaced `<server>__<tool>` entries in the agentic loop. The local-MCP path runs entirely client-side, so this also stays privacy-preserving — Ollama + local MCP servers means no cloud calls at all.

## What's NOT supported

- **`countTokens`.** Ollama doesn't expose a count endpoint. `BrainManager.countTokens` returns `null` when routed to Ollama. Apps that need a count call a local tokenizer (matching the model's tokenizer) or estimate.
- **Strict schema enforcement on `generate`.** The model isn't constrained to the schema by the runtime — `parseGenerated` (and `schema.parse` when set) catches mismatches at the boundary, but smaller models may need more aggressive prompt engineering or a larger model to behave.

## Other OpenAI-compatible local servers

The provider works against anything that exposes `/v1/chat/completions` in OpenAI shape. Just override `baseUrl`:

```ts
// LM Studio
{ driver: 'ollama', defaultModel: 'qwen2.5-7b-instruct', baseUrl: 'http://localhost:1234/v1' }

// llama.cpp server
{ driver: 'ollama', defaultModel: 'whatever-the-server-loaded', baseUrl: 'http://localhost:8080/v1' }

// vLLM
{ driver: 'ollama', defaultModel: 'meta-llama/Llama-3.2-3B-Instruct', baseUrl: 'http://vllm.internal:8000/v1' }

// Remote Ollama (different machine on the network)
{ driver: 'ollama', defaultModel: 'llama3.2', baseUrl: 'http://gpu-server.internal:11434/v1' }
```

The driver is `ollama` for all of these — the name is just for ergonomics; the provider is "any OpenAI-compatible local server."

## When to pick Ollama

| You want… | Pick |
|---|---|
| Privacy / on-prem / regulated workloads | Ollama (+ local MCP) |
| Free local dev / test runs | Ollama |
| Open-weights model evaluation | Ollama (or LM Studio / vLLM via the same provider) |
| Strict schema enforcement | OpenAI / Anthropic / Gemini |
| `countTokens` before you spend the call | Anthropic / Gemini |
| Best-in-class tool calling | Anthropic (or Llama 3.2+ / Qwen 2.5+ on Ollama for open-weights) |

The manager routes per-call: `brain.chat(text, { provider: 'ollama' })` runs against Ollama regardless of the default. A common pattern — point `default` at Ollama in dev, hosted in prod:

```ts
// config/brain.ts
export default {
  default: env('NODE_ENV') === 'production' ? 'anthropic' : 'ollama',
  providers: {
    anthropic: { driver: 'anthropic', apiKey: env('ANTHROPIC_API_KEY') },
    ollama: { driver: 'ollama', defaultModel: 'llama3.2' },
  },
}
```
