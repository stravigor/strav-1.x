# Zod helpers — `@strav/brain/zod`

The default `@strav/brain` import deliberately doesn't depend on Zod — `Tool.inputSchema` and `OutputSchema.jsonSchema` are plain JSON Schema so apps stay free to pick whatever schema library they like (Ajv, Valibot, ArkType, or nothing).

If you already use Zod, the `@strav/brain/zod` sub-path gives you two opt-in helpers that close the obvious tax:

- `outputSchema(zodSchema)` → `OutputSchema<z.infer<typeof zodSchema>>` for `brain.generate(...)`.
- `tool({ name, description, input, execute })` → `Tool<z.infer<typeof input>>` for `brain.runTools(...)` / `defineTool(...)`-style usage.

Both derive `jsonSchema` via Zod's built-in `z.toJSONSchema` and wire the `parse` hook to Zod, so the schema *is* the contract — no separate `zod-to-json-schema` install, no manual `parse` wrapper.

## Setup

```bash
bun add zod
```

`zod` is an **optional peer dependency** of `@strav/brain`. Apps that don't use Zod don't install it, don't bundle it, and never import this sub-path. Apps that do use Zod install it themselves at any compatible `^4.0.0` version.

## `outputSchema` — structured outputs

```ts
import { z } from 'zod'
import { outputSchema } from '@strav/brain/zod'

const City = z.object({
  city: z.string(),
  population: z.number().int(),
})

const { value } = await brain.generate(
  'What is the capital of France?',
  outputSchema(City, { name: 'city_answer' }),
)
//  ^? { city: string; population: number }

console.log(value.city, value.population)
```

What the helper does:

- `jsonSchema` ← `z.toJSONSchema(zodSchema)`.
- `parse` ← `(v) => zodSchema.parse(v)` — so the runtime validation that `BrainManager.generate` runs *is* the Zod schema. Provider-side enforcement is a first line of defense; Zod is the second.
- `description` ← the schema's `.describe(...)` text when set, unless the caller passes one explicitly.
- `name` defaults to `'output'`. Pass a stable identifier (`{ name: 'city_answer' }`) when you ship multiple schemas — OpenAI surfaces it on the wire and logs render it.

When the model returns valid JSON that fails Zod validation, `BrainManager.generate` throws `BrainError` with the underlying `ZodError` on `.cause` and the raw text on `.context.text`.

## `tool` — tool inputs

```ts
import { z } from 'zod'
import { tool } from '@strav/brain/zod'

const searchOrders = tool({
  name: 'search_orders',
  description: 'Look up an order by id.',
  input: z.object({ orderId: z.string() }),
  async execute({ orderId }, ctx) {
    //         ^? { orderId: string }
    return await orders.find(orderId, ctx.context)
  },
})

await brain.runTools('Find order ord_42', [searchOrders])
```

What the helper does:

- `inputSchema` ← `z.toJSONSchema(input)`.
- `execute` is wrapped — before calling the user's function, the wrapper runs `input.parse(rawFromModel)`, so the function receives an already-validated, fully-typed value. Validation failures propagate as `ZodError`; the agentic loop catches it and surfaces a `ToolExecutionError` with `cause` set to the `ZodError`.

The shape is otherwise identical to `defineTool` from the core barrel — `tool` is just `defineTool` with Zod inferring + validating.

## When NOT to use the Zod helpers

- **You're not using Zod elsewhere.** Plain JSON Schema + a hand-written `parse` (or none at all) keeps your bundle smaller.
- **You want a schema library other than Zod.** Write a similar helper against Valibot / ArkType / Effect Schema in your own codebase — the core API is intentionally schema-library-agnostic.
- **You don't trust the upstream provider's enforcement *and* you don't trust Zod.** This is rare, but in that case roll your own `parse` that runs your own validator.

## Tree-shaking and bundle cost

This sub-path is the only place in `@strav/brain` that imports `zod`. Apps that never import `@strav/brain/zod` pay zero bundle cost — both because the sub-path is a separate entry point and because `zod` is a peer dep, not a regular dep.

If you do import it, you pay the cost of Zod itself plus the helpers (which are a few dozen lines).
