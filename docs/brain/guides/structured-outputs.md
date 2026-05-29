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

## With `Agent`

`AgentRunner.output(schema)` switches a declarative agent into structured-output mode. The same agent + tier + system prompt — typed result:

```ts
class CityAgent extends Agent {
  override readonly instructions = 'You only emit verified city data.'
  override readonly tier = 'fast'
}

const { value } = await brain
  .agent(CityAgent)
  .input('Capital of France?')
  .output(citySchema)
  .run()
//  ^? AgentGenerateResult<CityAnswer>
```

`run()` returns `AgentGenerateResult<T>` — `{ value, text, messages, iterations, stopReason, usage }`. When the agent declares no tools, `iterations` is `0` (single `generate` call). When the agent declares `tools` or `mcpServers`, the runner takes the combined path (below) and `iterations` reflects the number of tool-use round-trips.

## With tools (combined path)

`.output(schema)` *does* combine with `tools` and `mcpServers`. The runner delegates to `BrainManager.generateWithTools`, which runs the standard agentic loop while pinning a JSON-Schema constraint on every turn. The model can still emit `tool_use` blocks during the loop — only the model's final turn (when it answers without calling a tool) emits JSON, and that JSON is parsed against the schema.

```ts
class ResearchAgent extends Agent {
  override readonly instructions = 'You summarize research findings.'
  override readonly tools = [searchPapers, fetchAbstract]
}

const { value, iterations } = await brain
  .agent(ResearchAgent)
  .input('What changed in transformer architectures in 2025?')
  .output(summarySchema)
  .run()
//  ^? AgentGenerateResult<Summary>
```

Manager-level access:

```ts
const result = await brain.generateWithTools<Summary>(
  'What changed in transformer architectures in 2025?',
  summarySchema,
  [searchPapers, fetchAbstract],
)
```

Per-provider mapping under the hood:

| Provider | What's added every turn |
|---|---|
| Anthropic | `output_config: { format: { type: 'json_schema', schema } }` |
| OpenAI | `response_format: { type: 'json_schema', json_schema: { …, strict: true } }` |
| Gemini | `config: { responseMimeType: 'application/json', responseJsonSchema: schema }` |

## Streaming

`BrainManager.streamGenerateWithTools<T>(input, schema, tools, options)` is the streaming twin of `generateWithTools`. Yields the standard `AgentStreamEvent<T>` vocabulary — text deltas, tool-use/result boundaries, per-iteration markers — and the terminal `stop` event carries the parsed `value: T` + raw `text`:

```ts
for await (const event of brain.streamGenerateWithTools<Summary>(prompt, summarySchema, [searchTool])) {
  if (event.type === 'text') process.stdout.write(event.delta)
  if (event.type === 'stop') {
    console.log('parsed:', event.value)   // ^? Summary
    console.log('iterations:', event.iterations)
  }
}
```

Same shape via the runner:

```ts
for await (const event of brain
  .agent(ResearchAgent)
  .input(query)
  .output(summarySchema)
  .stream()
) {
  // event.type === 'stop' → event.value is typed as Summary
}
```

Per-provider mapping is identical to the non-streaming path (`output_config.format` / `response_format.json_schema` / `responseJsonSchema`) — only the request switches to the streaming endpoint and the framework parses the final assembled text.

## What's deferred

(no longer carried — the streaming + tools + schema axes are now orthogonal)
