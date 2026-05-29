# OpenAI Responses API — `OpenAIResponsesProvider`

`@strav/brain` ships two OpenAI providers:

- **`OpenAIProvider`** (driver `'openai'`) — chat completions. Default for everything except server tools.
- **`OpenAIResponsesProvider`** (driver `'openai-responses'`) — backed by `client.responses.create`. Pick this when you need OpenAI's server-side tools or the Responses API's reasoning surfaces.

Same SDK, different endpoint. Apps register both and route per-call.

```ts
// config/brain.ts
import { env } from '@strav/kernel'
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'openai',
  providers: {
    openai: { driver: 'openai', apiKey: env('OPENAI_API_KEY') },
    'openai-responses': { driver: 'openai-responses', apiKey: env('OPENAI_API_KEY') },
  },
} satisfies BrainConfigShape

// Default chat → completions endpoint
const { text } = await brain.chat('Summarize this paragraph: ...')

// Server tools → Responses endpoint
const { text: researched } = await brain.chat(
  'What was the latest Anthropic safety paper? Summarize.',
  {
    provider: 'openai-responses',
    serverTools: [{ type: 'web_search' }],
  },
)
```

## Why two providers?

The Responses API and chat completions API have different request shapes (`input_items` vs `messages`), different response shapes (`output[]` vs `choices[]`), and different feature surfaces. The chat completions endpoint stays the simpler default for the most common workflows (chat / function calling / json_schema structured output / streaming).

The Responses API adds:

- **Server-side tools** — `web_search`, `code_interpreter`, plus `file_search` / `computer_use` / `image_generation` (V1 of this provider supports `web_search` + `code_interpreter` only).
- **Reasoning surfaces** — `reasoning.effort` maps the same way as chat completions but the response carries reasoning items inline.
- **Stateful conversations** — `previous_response_id` lets OpenAI manage history server-side (V1 of this provider doesn't use it; the framework manages history client-side per `Message[]`).

For apps that don't need server tools, **stick with `OpenAIProvider`**. It's simpler, has full schema support, and matches the rest of the framework's patterns.

## Config

```ts
interface OpenAIResponsesProviderConfig {
  driver: 'openai-responses'
  apiKey: string
  baseUrl?: string                          // override SDK base URL
  organization?: string
  defaultModel?: string                     // defaults to 'gpt-5'
  defaultMaxTokens?: number                 // → max_output_tokens (default 4096)
  defaultEmbedModel?: string                // inherited from chat completions
  defaultTranscribeModel?: string           // inherited from chat completions
}
```

`embed` + `transcribe` are inherited from `OpenAIProvider` — they hit `client.embeddings.create` and `client.audio.transcriptions.create` which are stable across both API surfaces.

## What's mapped

| Framework | Responses API |
|---|---|
| `Message[]` | `input: ResponseInputItem[]` — each user/assistant turn becomes an `EasyInputMessage`; tool results become standalone `function_call_output` items |
| `options.system` | `instructions` (top-level string) |
| `options.maxTokens` | `max_output_tokens` |
| `options.thinking: 'adaptive'` | `reasoning: { effort: 'medium' }` |
| `options.thinking: 'disabled'` | `reasoning: { effort: 'minimal' }` |
| `options.effort` | `reasoning: { effort: 'low' \| 'medium' \| 'high' \| ... }` |
| Framework `Tool[]` | `{ type: 'function', name, description, parameters: inputSchema, strict: false }` |
| `serverTools: [{ type: 'web_search' }]` | `{ type: 'web_search' }` |
| `serverTools: [{ type: 'code_execution' }]` | `{ type: 'code_interpreter', container: { type: 'auto' } }` |
| `serverTools: [{ type: 'web_fetch' }]` | throws (Anthropic-only) |
| `serverTools: [{ type: 'url_context' }]` | throws (Gemini-only) |
| Response `output[]` | `ChatResult.text` from `output_text` items; tool calls become `ToolUseBlock`s in `result.messages` |

## Server tools

The killer feature. `web_search` + `code_execution` work the same way as on Anthropic + Gemini at the framework level — set them on `options.serverTools` and the model uses them as it likes.

```ts
const result = await brain.chat(
  'Find all primes between 1000 and 2000 and sum them. Show your work.',
  {
    provider: 'openai-responses',
    serverTools: [{ type: 'code_execution' }],
  },
)
console.log(result.text)
// → "The sum of all primes from 1009 to 1999 is 175,196."
```

Mixed local + server tools work too:

```ts
await brain.runTools(
  'Research Q3 earnings, then email a summary to the team.',
  [emailSummaryTool],                                 // local
  {
    provider: 'openai-responses',
    serverTools: [{ type: 'web_search' }],            // server
  },
)
```

The model picks the right tool per step. Local tools execute in your process via the framework's agentic loop; server tools fire on OpenAI's side without round-tripping.

### `file_search` / `computer_use` / `image_generation`

Not in V1. These each need their own configuration (vector store IDs for `file_search`, virtual machine state for `computer_use`, response_format tweaks for `image_generation`) and each is its own slice.

## Streaming

`stream()` and `streamWithTools()` work — text deltas come through as `response.output_text.delta` events.

```ts
for await (const event of brain.streamTools(prompt, [], {
  provider: 'openai-responses',
  serverTools: [{ type: 'web_search' }],
})) {
  if (event.type === 'text') process.stdout.write(event.delta)
}
```

V1 doesn't surface server-tool execution events as `AgentStreamEvent`s — apps that want to render "(searching the web...)" indicators read from the post-completion `Response.output` (available on `event.messages` and `result.raw`).

## What's NOT in V1

- **Structured output via Responses API** — `generate()`, `runWithToolsAndSchema()`, `streamWithToolsAndSchema()` throw `BrainError`. Apps that want json_schema structured output route to the chat completions provider (driver `'openai'`); it does the same thing more cleanly.
- **`file_search`, `computer_use`, `image_generation`** server tools — each is its own slice when an app needs it.
- **`previous_response_id` stateful conversations** — the framework manages conversation history client-side per `Message[]`.
- **Reasoning summaries** — `gpt-5` and o-series models emit reasoning items in the response; the framework doesn't surface them as a typed block yet. Apps read from `result.raw`.

## When to pick which OpenAI provider

| You want… | Pick |
|---|---|
| Plain chat / function calling | `'openai'` |
| Structured output (json_schema) | `'openai'` |
| Streaming | either — pick `'openai'` unless you need server tools |
| Server tools (web_search / code_interpreter) | `'openai-responses'` |
| gpt-5 reasoning with `effort` knob | either — same translation on both |
| `embed` / `transcribe` | either — same endpoints |

The most common pattern: register both, default to `'openai'`, route to `'openai-responses'` per-call when server tools are needed.
