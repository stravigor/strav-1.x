/**
 * `OutputSchema<T>` — declarative description of a structured-output
 * target. Apps pass one of these to `BrainManager.generate(...)` and
 * get back a `GenerateResult<T>` whose `value` is the parsed JSON
 * the model produced.
 *
 * Schema shape:
 *   - `name` — short identifier; OpenAI requires it on
 *     `response_format.json_schema.name`. Other providers ignore it
 *     but apps should still set something stable and meaningful for
 *     logs / telemetry.
 *   - `description` — optional hint the model sees (some providers
 *     surface it next to the schema; others embed it in the prompt
 *     translation).
 *   - `jsonSchema` — plain JSON Schema (draft 2020-12 compatible).
 *     The framework deliberately doesn't depend on Zod; apps that
 *     want Zod use `zod-to-json-schema` (or similar) at the call
 *     site and feed the result here.
 *   - `parse` — optional runtime validator/parser. When set, the
 *     framework runs every model response through it before
 *     returning. Apps that just want type-level inference (and
 *     trust the model + provider validation) can omit it; the
 *     return type is then `T` by type assertion only.
 *
 * Why no built-in Zod dep:
 *   Same reason `Tool.inputSchema` is plain JSON Schema — Strav
 *   doesn't pin apps to a schema library. A thin `@strav/brain-zod`
 *   helper that produces `OutputSchema<T>` from a Zod schema is
 *   straightforward to ship later without touching this file.
 */

export interface OutputSchema<T = unknown> {
  /** Short identifier — provider-specific; some surface it, others ignore. */
  name: string
  /** Optional hint shown to the model alongside the schema. */
  description?: string
  /** JSON Schema describing the expected shape. */
  jsonSchema: Record<string, unknown>
  /** Optional runtime parser/validator. Apps that use Zod plug it in here. */
  parse?(value: unknown): T
}

/**
 * Shared helper used by every provider's `generate` implementation:
 * parse the raw JSON response, run the optional `parse` hook, and
 * wrap parse failures in `BrainError` with the raw text on `.context`
 * so apps can inspect what came back when validation rejects.
 */
import { BrainError } from './brain_error.ts'

export function parseGenerated<T>(text: string, schema: OutputSchema<T>): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new BrainError(
      `BrainProvider.generate: response was not valid JSON for schema "${schema.name}".`,
      { context: { schema: schema.name, text }, cause },
    )
  }
  if (schema.parse) {
    try {
      return schema.parse(parsed)
    } catch (cause) {
      throw new BrainError(
        `BrainProvider.generate: response failed schema.parse for "${schema.name}".`,
        { context: { schema: schema.name, text }, cause },
      )
    }
  }
  return parsed as T
}
