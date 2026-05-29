/**
 * `defineDurable(name, fn)` — declaration-style factory mirroring
 * `defineSchema(...)` / `defineMachine(...)` / `defineWorkflow(...)`.
 *
 * ```ts
 * export const milestone = defineDurable('milestone', (w) =>
 *   w.step('discover', async (ctx) => discover(ctx.input))
 *    .step('plan',     async (ctx) => plan(ctx.results.discover))
 *    .step('ship',     async (ctx) => ship(ctx.results.plan), {
 *      compensate: async (ctx) => rollbackShip(ctx.results.ship),
 *    })
 * )
 * ```
 *
 * The returned `DurableWorkflow` is what apps register on the runner.
 * Apps that prefer a more imperative shape can `new DurableWorkflow()`
 * directly — the factory is sugar.
 */

import { DurableWorkflow } from './durable_workflow.ts'

export function defineDurable(
  name: string,
  build: (workflow: DurableWorkflow) => DurableWorkflow,
): DurableWorkflow {
  const workflow = new DurableWorkflow(name)
  build(workflow)
  return workflow
}
