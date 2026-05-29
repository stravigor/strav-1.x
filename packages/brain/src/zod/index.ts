/**
 * `@strav/brain/zod` — Zod-flavored helpers on top of the
 * schema-library-agnostic core.
 *
 * The default `@strav/brain` import deliberately doesn't depend on
 * Zod — `Tool.inputSchema` and `OutputSchema.jsonSchema` are plain
 * JSON Schema so apps stay free to pick Ajv, Valibot, ArkType, or
 * nothing at all. This sub-path opt-in adds two thin wrappers for
 * apps that already use Zod:
 *
 *   - `outputSchema(z, opts?)` turns a Zod schema into an
 *     `OutputSchema<z.infer<typeof z>>` — `jsonSchema` is derived
 *     via Zod's built-in `z.toJSONSchema`, and `parse` is wired to
 *     `z.parse`. Apps then pass the result straight to
 *     `BrainManager.generate(input, schema)`.
 *
 *   - `tool({ name, description, input, execute })` turns a Zod
 *     schema for the tool's input into a framework `Tool` — the
 *     wrapper validates the model's raw input through the Zod
 *     schema before calling the app's `execute`. Apps get inferred
 *     types on `execute(input)` for free.
 *
 * `zod` is an optional peer dependency. Apps that don't use Zod
 * don't install it, don't bundle it, and never import this
 * sub-path — they keep using `defineTool` / hand-written
 * `OutputSchema` literals with raw JSON Schema.
 */

import { z } from 'zod'
import type { OutputSchema } from '../output_schema.ts'
import type { Tool, ToolContext } from '../tool.ts'

/**
 * Options for `outputSchema`. `name` defaults to `'output'` —
 * apps that surface multiple schemas in logs or to OpenAI's wire
 * format should pass a stable, descriptive identifier.
 */
export interface OutputSchemaOptions {
  /** Identifier — defaults to `'output'`. */
  name?: string
  /** Optional model-facing hint. Defaults to the Zod schema's `.describe(…)` if set. */
  description?: string
}

/**
 * Build an `OutputSchema<T>` from a Zod schema. The returned shape
 * is ready to pass to `BrainManager.generate(...)`.
 *
 * ```ts
 * const CityZ = z.object({ city: z.string(), population: z.number().int() })
 * const { value } = await brain.generate('Capital of France?', outputSchema(CityZ, { name: 'city_answer' }))
 * //      ^? { city: string; population: number }
 * ```
 */
export function outputSchema<T>(
  schema: z.ZodType<T>,
  options: OutputSchemaOptions = {},
): OutputSchema<T> {
  const description = options.description ?? zodDescription(schema)
  const result: OutputSchema<T> = {
    name: options.name ?? 'output',
    jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    parse: (value) => schema.parse(value),
  }
  if (description !== undefined) result.description = description
  return result
}

/**
 * Spec passed to `tool(...)`. `execute` receives the model's input
 * already validated + typed against `input` — no need to call
 * `input.parse` manually.
 */
export interface ZodToolSpec<TInput, TOutput> {
  name: string
  description: string
  input: z.ZodType<TInput>
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}

/**
 * Build a framework `Tool` from a Zod-typed spec. The wrapper
 * derives `inputSchema` via `z.toJSONSchema` and validates the
 * model's raw input through `input.parse` before delegating to
 * `execute`. Validation failures propagate as `ZodError`; the
 * agentic loop wraps that into a `ToolExecutionError`.
 *
 * ```ts
 * const search = tool({
 *   name: 'search_orders',
 *   description: 'Look up an order by id.',
 *   input: z.object({ orderId: z.string() }),
 *   async execute({ orderId }, ctx) {
 *     //         ^? { orderId: string }
 *     return await orders.find(orderId, ctx.context)
 *   },
 * })
 * ```
 */
export function tool<TInput, TOutput>(
  spec: ZodToolSpec<TInput, TOutput>,
): Tool<TInput, TOutput> {
  const jsonSchema = z.toJSONSchema(spec.input) as Record<string, unknown>
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchema,
    async execute(raw: TInput, ctx: ToolContext): Promise<TOutput> {
      const parsed = spec.input.parse(raw)
      return spec.execute(parsed, ctx)
    },
  }
}

function zodDescription(schema: z.ZodType<unknown>): string | undefined {
  // Zod stores `.describe(…)` on the schema's `_def`; surface it
  // as the model-facing hint when callers don't pass one
  // explicitly.
  const def = (schema as unknown as { description?: string }).description
  return typeof def === 'string' && def.length > 0 ? def : undefined
}
