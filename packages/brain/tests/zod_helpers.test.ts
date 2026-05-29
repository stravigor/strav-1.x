/**
 * `@strav/brain/zod` tests — verify that `outputSchema` and `tool`
 * round-trip Zod schemas correctly:
 *
 *   - jsonSchema derived via Zod's built-in `z.toJSONSchema`
 *   - parse hook actually runs through `z.parse` (so bad shapes throw)
 *   - tool wrapper validates the model's raw input before delegating
 *   - description bubbles up from `.describe(...)` when not overridden
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { outputSchema, tool } from '../src/zod/index.ts'

describe('outputSchema()', () => {
  test('derives jsonSchema from the Zod schema', () => {
    const Schema = z.object({
      city: z.string(),
      population: z.number().int(),
    })
    const out = outputSchema(Schema, { name: 'city_answer' })
    expect(out.name).toBe('city_answer')
    expect(out.jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        city: { type: 'string' },
        population: { type: 'integer' },
      },
      required: ['city', 'population'],
      additionalProperties: false,
    })
  })

  test('parse hook runs the Zod parser — accepts valid, throws on invalid', () => {
    const Schema = z.object({ n: z.number().int() })
    const out = outputSchema(Schema, { name: 'n_schema' })
    expect(out.parse?.({ n: 3 })).toEqual({ n: 3 })
    expect(() => out.parse?.({ n: 'three' })).toThrow()
  })

  test('inherits description from .describe() when options.description omitted', () => {
    const Schema = z
      .object({ x: z.string() })
      .describe('Returns the X value.')
    const out = outputSchema(Schema)
    expect(out.description).toBe('Returns the X value.')
  })

  test('explicit options.description wins over .describe()', () => {
    const Schema = z.object({ x: z.string() }).describe('inherited')
    const out = outputSchema(Schema, { description: 'override' })
    expect(out.description).toBe('override')
  })

  test('defaults name to "output" when not supplied', () => {
    const out = outputSchema(z.object({}))
    expect(out.name).toBe('output')
  })
})

describe('tool()', () => {
  test('builds a Tool with jsonSchema derived from the Zod input', () => {
    const t = tool({
      name: 'search_orders',
      description: 'Look up an order by id.',
      input: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => `order:${orderId}`,
    })
    expect(t.name).toBe('search_orders')
    expect(t.description).toBe('Look up an order by id.')
    expect(t.inputSchema).toMatchObject({
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    })
  })

  test('execute receives parsed + typed input', async () => {
    let seen: unknown
    const t = tool({
      name: 'echo',
      description: 'echo',
      input: z.object({ a: z.string(), b: z.number() }),
      execute: async (input) => {
        seen = input
        return input.a + input.b
      },
    })
    const result = await t.execute({ a: 'x', b: 1 }, { callId: 'c', context: {} })
    expect(seen).toEqual({ a: 'x', b: 1 })
    expect(result).toBe('x1')
  })

  test('invalid input throws — caller surfaces it as ToolExecutionError', async () => {
    const t = tool({
      name: 'strict',
      description: 'strict input',
      input: z.object({ n: z.number().int() }),
      execute: async () => 'ok',
    })
    await expect(
      t.execute({ n: 'not a number' } as unknown as { n: number }, {
        callId: 'c',
        context: {},
      }),
    ).rejects.toThrow()
  })

  test('ctx is forwarded to execute', async () => {
    let seenCtx: unknown
    const t = tool({
      name: 'who',
      description: 'reads ctx',
      input: z.object({}),
      execute: async (_input, ctx) => {
        seenCtx = ctx.context
        return 'ok'
      },
    })
    await t.execute({}, { callId: 'c', context: { userId: 'u_42' } })
    expect(seenCtx).toEqual({ userId: 'u_42' })
  })
})
