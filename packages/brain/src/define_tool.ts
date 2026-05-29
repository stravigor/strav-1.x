/**
 * `defineTool({ name, description, inputSchema, execute })` — typed
 * factory mirroring `defineWorkflow` / `defineMachine` / `defineDurable`.
 *
 * ```ts
 * const getWeather = defineTool({
 *   name: 'get_weather',
 *   description: 'Get current weather for a location.',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { city: { type: 'string' } },
 *     required: ['city'],
 *   },
 *   execute: async ({ city }: { city: string }, ctx) => {
 *     return weatherService.lookup(city, ctx.context.userId as string)
 *   },
 * })
 * ```
 *
 * The generic parameters are usually inferred from `execute`'s first
 * arg + return type; apps that want explicit typing pass them.
 */

import type { Tool, ToolContext } from './tool.ts'

export interface DefineToolSpec<TInput, TOutput> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  spec: DefineToolSpec<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: spec.execute,
  }
}
