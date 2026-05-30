/**
 * `Agent<T>` class-side outputSchema tests.
 *
 * Verifies:
 *   - A subclass extending `Agent<T>` with a class-side
 *     `outputSchema` returns `AgentGenerateResult<T>` from
 *     `brain.agent(Class).input(...).run()` — no per-call
 *     `.output(schema)` needed.
 *   - A subclass extending plain `Agent` (T = never) still returns
 *     `AgentResult` — backward-compat unchanged.
 *   - A per-call `.output(otherSchema)` overrides the class-side
 *     schema at runtime.
 */

import { describe, expect, test } from 'bun:test'
import { Agent } from '../src/agent.ts'
import type { AgentGenerateResult } from '../src/agent_generate_result.ts'
import { BrainManager } from '../src/brain_manager.ts'
import type { OutputSchema } from '../src/output_schema.ts'
import type { BrainDriver } from '../src/brain_driver.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  GenerateResult,
  Message,
  StreamEvent,
} from '../src/types.ts'

interface City {
  city: string
  population: number
}

const citySchema: OutputSchema<City> = {
  name: 'city_answer',
  jsonSchema: {
    type: 'object',
    properties: { city: { type: 'string' }, population: { type: 'integer' } },
    required: ['city', 'population'],
    additionalProperties: false,
  },
}

interface Weather {
  temp: number
}

const weatherSchema: OutputSchema<Weather> = {
  name: 'weather',
  jsonSchema: {
    type: 'object',
    properties: { temp: { type: 'integer' } },
    required: ['temp'],
    additionalProperties: false,
  },
}

const emptyUsage: ChatUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

class StubProvider implements BrainDriver {
  readonly name = 'stub'
  readonly generateCalls: Array<{ schema: OutputSchema<unknown> }> = []
  private readonly response: GenerateResult<unknown>

  constructor(response: GenerateResult<unknown>) {
    this.response = response
  }

  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
  async generate<U>(
    _messages: readonly Message[],
    schema: OutputSchema<U>,
    _options?: ChatOptions,
  ): Promise<GenerateResult<U>> {
    this.generateCalls.push({ schema: schema as OutputSchema<unknown> })
    return this.response as GenerateResult<U>
  }
}

// ─── Agent<T> with class-side schema ─────────────────────────────────────

class CityAgent extends Agent<City> {
  override readonly instructions = 'You only emit verified city data.'
  override readonly outputSchema = citySchema
  override readonly tier = 'fast'
}

describe('Agent<T> — class-side outputSchema', () => {
  test('brain.agent(Class).input(q).run() returns AgentGenerateResult<T> with no per-call .output', async () => {
    const provider = new StubProvider({
      value: { city: 'Paris', population: 2148000 },
      text: '{"city":"Paris","population":2148000}',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<City>)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    const result = await brain.agent(CityAgent).input('Capital of France?').run()

    // TypeScript already knows `result.value` is `City`. At runtime:
    expect(result.value).toEqual({ city: 'Paris', population: 2148000 })
    expect(result.iterations).toBe(0)
    expect(provider.generateCalls).toHaveLength(1)
    expect(provider.generateCalls[0]?.schema).toBe(citySchema)

    // Verify the static type — assigning to AgentGenerateResult<City>
    // would fail to compile if `run()` returned `AgentResult`.
    const typed: AgentGenerateResult<City> = result
    expect(typed.value.city).toBe('Paris')
  })

  test('per-call .output(otherSchema) overrides the class-side schema', async () => {
    const provider = new StubProvider({
      value: { temp: 42 },
      text: '{"temp":42}',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<Weather>)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    const result = await brain
      .agent(CityAgent)
      .input('current temperature?')
      .output(weatherSchema)
      .run()

    expect(result.value).toEqual({ temp: 42 })
    expect(provider.generateCalls[0]?.schema).toBe(weatherSchema)
  })
})

// ─── Backward compat: plain Agent stays Agent<never> ─────────────────────

class LegacyAgent extends Agent {
  override readonly instructions = 'plain agent, no schema'
  override readonly tier = 'fast'
}

class StubToolProvider implements BrainDriver {
  readonly name = 'stub'
  readonly runWithToolsCalls: Array<{ messages: readonly Message[] }> = []
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
  async runWithTools(messages: readonly Message[]) {
    this.runWithToolsCalls.push({ messages })
    return {
      text: 'unstructured',
      messages: [{ role: 'assistant' as const, content: 'unstructured' }],
      iterations: 0,
      stopReason: 'end_turn',
      usage: emptyUsage,
    }
  }
}

describe('Agent (no generic) — backward compat', () => {
  test('plain Agent subclass returns AgentResult, generate is never called', async () => {
    const provider = new StubToolProvider()
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    const result = await brain.agent(LegacyAgent).input('q').run()

    expect(result.text).toBe('unstructured')
    expect(provider.runWithToolsCalls).toHaveLength(1)
  })
})
