/**
 * Tests for `AgentRunner.output(schema)` — the structured-output
 * mode on top of the declarative `Agent` runner. Covers the
 * happy path (returns `AgentGenerateResult<T>`) and the options
 * threading (system / tier / provider).
 *
 * The combined `tools` / `mcpServers` + schema path is covered
 * separately in `run_with_tools_and_schema.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { Agent } from '../src/agent.ts'
import { BrainManager } from '../src/brain_manager.ts'
import type { OutputSchema } from '../src/output_schema.ts'
import type { Provider } from '../src/provider.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  GenerateResult,
  Message,
  StreamEvent,
} from '../src/types.ts'

// ─── Stub provider that records generate() calls ─────────────────────────

interface GenerateCall {
  messages: readonly Message[]
  schema: OutputSchema<unknown>
  options?: ChatOptions
}

class StubProvider implements Provider {
  readonly name: string
  readonly generateCalls: GenerateCall[] = []
  private readonly result: GenerateResult<unknown>

  constructor(name: string, result: GenerateResult<unknown>) {
    this.name = name
    this.result = result
  }

  async chat(): Promise<ChatResult> { throw new Error('chat not used') }
  async *stream(): AsyncIterable<StreamEvent> {}
  async generate<U>(
    messages: readonly Message[],
    schema: OutputSchema<U>,
    options?: ChatOptions,
  ): Promise<GenerateResult<U>> {
    this.generateCalls.push({ messages, schema: schema as OutputSchema<unknown>, options })
    return this.result as GenerateResult<U>
  }
}

const emptyUsage: ChatUsage = {
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

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

class CityAgent extends Agent {
  override readonly instructions = 'You only emit verified city data.'
  override readonly tier = 'fast'
  override readonly maxTokens = 512
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('AgentRunner.output()', () => {
  test('returns an AgentGenerateResult<T> with parsed value + trace', async () => {
    const provider = new StubProvider('stub', {
      value: { city: 'Paris', population: 2148000 },
      text: '{"city":"Paris","population":2148000}',
      model: 'stub-model',
      stopReason: 'stop',
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<City>)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    const result = await brain
      .agent(CityAgent)
      .input('Capital of France?')
      .output(citySchema)
      .run()

    expect(result.value).toEqual({ city: 'Paris', population: 2148000 })
    expect(result.text).toBe('{"city":"Paris","population":2148000}')
    expect(result.iterations).toBe(0)
    expect(result.stopReason).toBe('stop')
    expect(result.usage).toEqual(emptyUsage)
    expect(result.messages).toEqual([
      { role: 'user', content: 'Capital of France?' },
      { role: 'assistant', content: '{"city":"Paris","population":2148000}' },
    ])
  })

  test('threads the agent\'s system + tier + maxTokens into generate options', async () => {
    const provider = new StubProvider('stub', {
      value: { city: 'x', population: 0 },
      text: '{"city":"x","population":0}',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<City>)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    await brain.agent(CityAgent).input('q').output(citySchema).run()

    const call = provider.generateCalls[0]
    expect(call?.options?.system).toBe('You only emit verified city data.')
    expect(call?.options?.model).toBe('claude-haiku-4-5') // tier 'fast' resolved
    expect(call?.options?.maxTokens).toBe(512)
  })

  test('order of chaining doesn\'t matter — .output before or after .input', async () => {
    const provider = new StubProvider('stub', {
      value: { city: 'Berlin', population: 3645000 },
      text: '{"city":"Berlin","population":3645000}',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<City>)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    const a = await brain.agent(CityAgent).input('q').output(citySchema).run()
    const b = await brain.agent(CityAgent).output(citySchema).input('q').run()

    expect(a.value).toEqual(b.value)
    expect(provider.generateCalls).toHaveLength(2)
  })

  test('routes to options.provider via the agent.provider override', async () => {
    const a = new StubProvider('a', {
      value: { city: 'A', population: 1 },
      text: '{"city":"A","population":1}',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<City>)
    const b = new StubProvider('b', {
      value: { city: 'B', population: 2 },
      text: '{"city":"B","population":2}',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    } satisfies GenerateResult<City>)
    class BAgent extends CityAgent {
      override readonly provider = 'b'
    }
    const brain = new BrainManager({ default: 'a', providers: { a, b } })

    const result = await brain.agent(BAgent).input('q').output(citySchema).run()
    expect(result.value.city).toBe('B')
    expect(a.generateCalls).toHaveLength(0)
    expect(b.generateCalls).toHaveLength(1)
  })

  // The previous "throws when tools/mcpServers declared" tests were
  // removed when the combined tool + schema path landed. The happy
  // path for that combination lives in run_with_tools_and_schema.test.ts.

  test('runner.run() before input() still throws even in output mode', async () => {
    const provider = new StubProvider('stub', {
      value: null as unknown as City,
      text: 'null',
      model: 'm',
      stopReason: null,
      usage: emptyUsage,
      raw: undefined,
    })
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })
    const runner = brain.agent(CityAgent).output(citySchema)
    await expect(runner.run()).rejects.toThrow(/input\(\) must be called/)
  })
})
