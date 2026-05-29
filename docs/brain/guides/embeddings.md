# Embeddings — `brain.embed(...)`

`BrainManager.embed(input, options?)` turns one or more text inputs into embedding vectors — the foundation primitive for RAG, similarity search, clustering, and any other vector-space workflow.

```ts
const { embeddings } = await brain.embed('The quick brown fox.')
//      ^? number[][]                 // one vector for one input
console.log(embeddings[0].length)     // e.g. 1536 for text-embedding-3-small
```

Batch:

```ts
const docs = ['First document', 'Second document', 'Third document']
const { embeddings, usage } = await brain.embed(docs)
//      ^? number[][]                 // embeddings[i] = vector for docs[i]
console.log(usage.inputTokens)
```

## Provider support

| Provider | Supports embed? | Default model | Notes |
|---|---|---|---|
| **OpenAI** | yes | `text-embedding-3-small` | `text-embedding-3-large` for higher fidelity; `options.dimensions` truncates the output vector. |
| **Gemini** | yes | `text-embedding-004` | `gemini-embedding-001` for newer models; `options.dimensions` → `outputDimensionality`. `usage.inputTokens` is `0` — Gemini's embed endpoint doesn't surface token counts. |
| **Ollama** | yes | (none — required) | `defaultEmbedModel` must be set on the config; pull an embedding-tuned model first (`ollama pull nomic-embed-text`). |
| **DeepSeek** | no | — | Throws `BrainError` — DeepSeek has no embeddings API. Route embed calls to a different provider. |
| **Anthropic** | no | — | Anthropic doesn't expose embeddings (their official recommendation is Voyage). `BrainManager.embed` throws when routed here. |

## Configuration

```ts
// config/brain.ts
import { env } from '@strav/kernel'
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'openai',
  providers: {
    openai: {
      driver: 'openai',
      apiKey: env('OPENAI_API_KEY'),
      defaultEmbedModel: 'text-embedding-3-small',   // optional; the default
    },
    ollama: {
      driver: 'ollama',
      defaultModel: 'llama3.2',
      defaultEmbedModel: 'nomic-embed-text',          // required for embed
    },
  },
} satisfies BrainConfigShape
```

## `EmbedOptions`

```ts
interface EmbedOptions {
  model?: string                  // override defaultEmbedModel
  provider?: string               // override the default provider
  dimensions?: number             // OpenAI: dimensions; Gemini: outputDimensionality
  signal?: AbortSignal            // cancellation (same shape as ChatOptions.signal)
}
```

`options.dimensions` lets apps trade fidelity for storage size. OpenAI's models support arbitrary truncation; Gemini supports it on text-embedding-004+ ; Ollama models vary.

## `EmbedResult`

```ts
interface EmbedResult<Raw = unknown> {
  embeddings: number[][]          // one vector per input, in order
  model: string                   // model that actually produced them
  usage: { inputTokens: number }  // tokens consumed (0 on Gemini — see table)
  raw: Raw                        // provider's full native response
}
```

Cancellation works the same as everywhere else:

```ts
const ac = new AbortController()
setTimeout(() => ac.abort(), 5_000)

try {
  const { embeddings } = await brain.embed(longList, { signal: ac.signal })
} catch (err) {
  if ((err as { name?: string }).name === 'AbortError') { /* … */ }
}
```

## Routing across providers

The same per-call `provider` override works for embeddings as for chat:

```ts
// Default provider does chat...
const { text } = await brain.chat(question)

// ...but use a different one for embeddings (e.g. cheap local Ollama)
const { embeddings } = await brain.embed(docs, { provider: 'ollama' })
```

A common pattern — Anthropic for chat + OpenAI/Ollama for embeddings (since Anthropic doesn't have embed):

```ts
export default {
  default: 'anthropic',
  providers: {
    anthropic: { driver: 'anthropic', apiKey: env('ANTHROPIC_API_KEY') },
    openai: { driver: 'openai', apiKey: env('OPENAI_API_KEY') },
  },
}

// chat goes to Anthropic by default
const { text } = await brain.chat(...)

// embed explicitly to OpenAI — Anthropic would throw
const { embeddings } = await brain.embed(docs, { provider: 'openai' })
```

## When NOT to use `brain.embed`

- **You need the same provider for both chat + embeddings AND you've picked Anthropic / DeepSeek.** They don't have embeddings. Route embed elsewhere or pick a different chat provider.
- **You're calling it once per document in a hot loop.** Batch — pass an array to `embed` and process N at a time. OpenAI / Gemini both batch on the wire.
- **You need a non-text modality (image / audio embedding).** V1 covers text only. Multimodal embeddings ship when multimodal content blocks land.

## What's deferred

- **Image / audio / video embeddings.** Some models (OpenAI's CLIP-derived, Gemini's multimodal embed) accept non-text inputs. The framework's `embed` is text-only in V1; multimodal lands with the broader multimodal-content-block slice.
- **Per-input cost accounting on Gemini.** The Gemini Developer API doesn't surface embed-token usage in the response. Apps that need exact accounting call `brain.countTokens(input)` separately before the embed call.
- **Voyage / Cohere providers.** Apps that want best-in-class embedding models (Voyage's voyage-3, Cohere's embed-v3) plug in their own `Provider` impl today. A first-class subclass lands when an app needs it.
