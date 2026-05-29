# Structured outputs

`BrainManager.generate(input, schema, options?)` returns a JSON object shaped to a schema you pass in — no prompt engineering, no "respond with JSON" plea, no post-hoc regex extraction. Every V1 provider supports it (Anthropic, OpenAI, Gemini) and the call shape is provider-agnostic.

```ts
import type { OutputSchema } from '@strav/brain'

interface CityAnswer {
  city: string
  population: number
}

const citySchema: OutputSchema<CityAnswer> = {
  name: 'city_answer',
  description: 'A city + its current population.',
  jsonSchema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      population: { type: 'integer' },
    },
    required: ['city', 'population'],
    additionalProperties: false,
  },
}

const { value } = await brain.generate('Capital of France?', citySchema)
//      ^? CityAnswer
console.log(value.city)        // 'Paris'
console.log(value.population)  // 2148000
```

## The schema shape

```ts
interface OutputSchema<T = unknown> {
  name: string                              // identifier — surfaces in OpenAI's wire format and in logs
  description?: string                      // optional hint shown to the model
  jsonSchema: Record<string, unknown>       // JSON Schema (draft 2020-12)
  parse?(value: unknown): T                 // optional runtime validator/parser
}
```

The framework deliberately doesn't depend on Zod. Apps that use Zod build the schema with `zod-to-json-schema` (or similar) and plug `z.parse` into the `parse` hook:

```ts
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const CityZ = z.object({ city: z.string(), population: z.number().int() })
type CityAnswer = z.infer<typeof CityZ>

const citySchema: OutputSchema<CityAnswer> = {
  name: 'city_answer',
  jsonSchema: zodToJsonSchema(CityZ) as Record<string, unknown>,
  parse: (raw) => CityZ.parse(raw),
}
```

When `parse` is omitted, the returned `value` is `T` by type assertion — the framework trusts the model + the provider's upstream schema enforcement. Apps that want belt-and-braces runtime validation always supply `parse`.

## Return shape

```ts
interface GenerateResult<T> {
  value: T                  // parsed JSON, optionally run through schema.parse
  text: string              // raw JSON string the model produced
  model: string
  stopReason: string | null
  usage: ChatUsage
  raw: unknown              // provider's full native response
}
```

`text` is useful when `schema.parse` rejects — the raw response also lands on `BrainError.context.text` so you can read it from a caught exception.

## Per-provider mapping

| Provider | Wire | Notes |
|---|---|---|
| **Anthropic** | `output_config: { format: { type: 'json_schema', schema } }` | Uses the native structured-output surface. Response carries the JSON in the assistant text block. |
| **OpenAI** | `response_format: { type: 'json_schema', json_schema: { name, description?, schema, strict: true } }` | `strict: true` so OpenAI enforces the schema upstream — any model output that doesn't validate is rejected before it reaches you. |
| **Gemini** | `config: { responseMimeType: 'application/json', responseJsonSchema: schema }` | Gemini accepts JSON Schema verbatim via `responseJsonSchema`; no translation to its `Schema` form needed. |

All three providers reject the call if the model can't satisfy the schema after their own internal repair passes. The framework's `parse` hook (when set) adds a second layer for stricter apps.

## Errors

`BrainManager.generate` throws `BrainError` when:

- The configured (or `options.provider`-overridden) provider doesn't implement `generate` (none do today; this is the V1 escape hatch for custom providers).
- The response wasn't valid JSON. `BrainError.context` carries `{ schema: <name>, text: <raw> }`.
- `schema.parse` threw. `BrainError.cause` carries the underlying validator error; `BrainError.context` carries the raw text.

```ts
try {
  const { value } = await brain.generate('q', citySchema)
} catch (e) {
  if (e instanceof BrainError) {
    console.error(`Schema "${e.context.schema}" rejected; raw was:`, e.context.text)
  }
}
```

## When NOT to use `generate`

- **You're in a tool loop.** When the agent is already calling tools, prefer a `defineTool` whose `inputSchema` describes the structured payload — the model has already learned to emit tool-call JSON; you don't need a second mechanism.
- **The output is free-form prose.** `chat()` gives you a string. Don't wrap prose in a `{ "text": "..." }` schema just to use `generate`.
- **You're streaming the response.** `generate` is non-streaming. Apps that want tokens-as-they-arrive use `stream()` and parse JSON at the end (or per-line if the schema allows JSONL).

## Tier + provider routing

`generate` accepts the same `ChatOptions` as `chat`: `model`, `tier`, `system`, `maxTokens`, `thinking`, `effort`, `cache`, `provider`. Tier sugar resolves to a concrete model via `config.brain.tiers` before delegation:

```ts
const { value } = await brain.generate(prompt, citySchema, {
  tier: 'fast',
  provider: 'google',
  system: 'You only output verified facts.',
})
```

## What's deferred

- **Streaming structured outputs.** All three providers support partial JSON streams; the framework's `generate` is one-shot today. Streaming lands when the streaming-agents slice does.
- **`brain.agent(MyAgent).output(schema).run()`.** Plumbing the schema into the `Agent` runner is a natural next step — out of scope for this slice.
- **Built-in Zod helper.** A `@strav/brain-zod` package that produces `OutputSchema<z.infer<typeof z>>` in one call is straightforward; not in this slice.
