/**
 * `defineWorkflow(name)` — sugar over `new Workflow(name)` so app code
 * reads as a declaration rather than a constructor call. Mirrors the
 * `defineSchema(...)` convention in `@strav/database`.
 *
 * Pass the `Input` generic when the workflow's input shape is known
 * up-front; results accumulate as steps land via the typed builder.
 *
 * ```ts
 * export const processOrder = defineWorkflow<{ orderId: string }>('order:process')
 *   .step('validate', async (ctx) => validate(ctx.input.orderId))
 *   .step('charge',   async (ctx) => charge(ctx.results.validate.total))
 * ```
 */

import { Workflow } from './workflow.ts'

export function defineWorkflow<Input = unknown>(name: string): Workflow<Input> {
  return new Workflow<Input>(name)
}
