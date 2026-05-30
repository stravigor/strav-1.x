/**
 * `Provider.streamWithToolsAndSchema` +
 * `BrainManager.streamGenerateWithTools` + `AgentRunner.stream()`
 * with `.output(schema)`.
 *
 * Verifies the schema params are injected on every turn, the loop
 * still flows through tool execution, and the terminal `stop`
 * event carries the parsed `value` + raw `text` typed against `T`.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { Agent } from '../src/agent.ts'
import type { AgentStreamEvent } from '../src/agent_stream_event.ts'
import { BrainError } from '../src/brain_error.ts'
import { BrainManager } from '../src/brain_manager.ts'
import { defineTool } from '../src/define_tool.ts'
import type { OutputSchema } from '../src/output_schema.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'
import type { BrainDriver, RunWithToolsOptions } from '../src/brain_driver.ts'
import type { Tool } from '../src/tool.ts'
import type { ChatResult, Message, StreamEvent } from '../src/types.ts'

interface Answer {
  city: string
  population: number
}

const citySchema: OutputSchema<Answer> = {
  name: 'city_answer',
  description: 'A city + population.',
  jsonSchema: {
    type: 'object',
    properties: { city: { type: 'string' }, population: { type: 'integer' } },
    required: ['city', 'population'],
    additionalProperties: false,
  },
}

async function collect<T>(it: AsyncIterable<AgentStreamEvent<T>>): Promise<AgentStreamEvent<T>[]> {
  const out: AgentStreamEvent<T>[] = []
  for await (const e of it) out.push(e)
  return out
}

// ─── AnthropicBrainDriver.streamWithToolsAndSchema ──────────────────────────

function makeAnthropicMessage(opts: {
  text?: string
  toolUses?: Array<{ id: string; name: string; input: unknown }>
  stopReason: string
}): Anthropic.Message {
  const content: Array<
    | { type: 'text'; text: string; citations: null }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  > = []
  if (opts.text) content.push({ type: 'text', text: opts.text, citations: null })
  for (const u of opts.toolUses ?? []) {
    content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input })
  }
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content,
    stop_reason: opts.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

function makeAnthropicStream(deltas: string[], final: Anthropic.Message) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const d of deltas) {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: d },
        }
      }
    },
    async finalMessage() { return final },
  }
}

describe('AnthropicBrainDriver.streamWithToolsAndSchema', () => {
  test('injects output_config every turn + terminal stop carries value + text', async () => {
    const final1 = makeAnthropicMessage({
      toolUses: [{ id: 't1', name: 'lookup', input: { name: 'Paris' } }],
      stopReason: 'tool_use',
    })
    const final2 = makeAnthropicMessage({
      text: '{"city":"Paris","population":2148000}',
      stopReason: 'end_turn',
    })
    const queue = [
      { deltas: [], final: final1 },
      { deltas: ['{"city":"Paris",', '"population":2148000}'], final: final2 },
    ]
    const capturedParams: Anthropic.MessageCreateParams[] = []
    const client = {
      messages: {
        stream: (params: Anthropic.MessageCreateParams) => {
          capturedParams.push(params)
          const next = queue.shift()!
          return makeAnthropicStream(next.deltas, next.final)
        },
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'lookup',
      description: 'look up a city',
      inputSchema: { type: 'object' },
      execute: async () => 'data',
    })
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithToolsAndSchema(
        [{ role: 'user', content: 'population of Paris?' }],
        [tool],
        citySchema,
      ),
    )
    // All requests carry output_config.format
    for (const params of capturedParams) {
      const p = params as Anthropic.MessageCreateParams & {
        output_config?: { format?: { type: string; schema?: unknown } }
      }
      expect(p.output_config?.format).toEqual({
        type: 'json_schema',
        schema: citySchema.jsonSchema,
      })
    }
    const types = events.map((e) => e.type)
    expect(types).toContain('iteration_start')
    expect(types).toContain('tool_use')
    expect(types).toContain('tool_result')
    expect(types).toContain('text')
    const stop = events.at(-1)
    expect(stop?.type).toBe('stop')
    if (stop?.type === 'stop') {
      expect(stop.value).toEqual({ city: 'Paris', population: 2148000 })
      expect(stop.text).toBe('{"city":"Paris","population":2148000}')
      expect(stop.iterations).toBe(1)
    }
  })
})

// ─── OpenAIBrainDriver.streamWithToolsAndSchema ─────────────────────────────

interface FakeOpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

function makeOpenAIStream(chunks: FakeOpenAIChunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

describe('OpenAIBrainDriver.streamWithToolsAndSchema', () => {
  test('injects response_format every turn + terminal stop carries value + text', async () => {
    const turn1: FakeOpenAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'lookup' } },
                { index: 0, function: { arguments: '{"name":"Berlin"}' } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      },
    ]
    const turn2: FakeOpenAIChunk[] = [
      { choices: [{ delta: { content: '{"city":"Berlin",' } }] },
      { choices: [{ delta: { content: '"population":3645000}' } }] },
      {
        choices: [{ finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      },
    ]
    const queued = [turn1, turn2]
    const capturedParams: OpenAI.Chat.ChatCompletionCreateParams[] = []
    const client = {
      chat: {
        completions: {
          create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
            capturedParams.push(params)
            return makeOpenAIStream(queued.shift() ?? [])
          },
        },
      },
    } as unknown as OpenAI
    const tool = defineTool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object' },
      execute: async () => 'data',
    })
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithToolsAndSchema(
        [{ role: 'user', content: 'Berlin pop?' }],
        [tool],
        citySchema,
      ),
    )
    for (const params of capturedParams) {
      expect(params.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'city_answer',
          description: 'A city + population.',
          schema: citySchema.jsonSchema,
          strict: true,
        },
      })
    }
    const stop = events.at(-1)
    expect(stop?.type).toBe('stop')
    if (stop?.type === 'stop') {
      expect(stop.value).toEqual({ city: 'Berlin', population: 3645000 })
      expect(stop.text).toBe('{"city":"Berlin","population":3645000}')
      expect(stop.iterations).toBe(1)
    }
  })
})

// ─── GeminiBrainDriver.streamWithToolsAndSchema ─────────────────────────────

function makeGeminiChunk(opts: {
  text?: string
  functionCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>
  finishReason?: string
}): GenerateContentResponse {
  const parts: Array<{ text?: string; functionCall?: { id?: string; name: string; args: Record<string, unknown> } }> = []
  if (opts.text) parts.push({ text: opts.text })
  for (const fc of opts.functionCalls ?? []) parts.push({ functionCall: fc })
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: opts.finishReason }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
  } as unknown as GenerateContentResponse
}

describe('GeminiBrainDriver.streamWithToolsAndSchema', () => {
  test('injects responseJsonSchema every turn + terminal stop carries value + text', async () => {
    const turn1 = [
      makeGeminiChunk({
        functionCalls: [{ id: 'c1', name: 'lookup', args: { name: 'Tokyo' } }],
        finishReason: 'STOP',
      }),
    ]
    const turn2 = [
      makeGeminiChunk({ text: '{"city":"Tokyo",' }),
      makeGeminiChunk({ text: '"population":13960000}', finishReason: 'STOP' }),
    ]
    const queued: GenerateContentResponse[][] = [turn1, turn2]
    const capturedParams: GenerateContentParameters[] = []
    const client = {
      models: {
        generateContent: async () => ({}) as GenerateContentResponse,
        generateContentStream: async (params: GenerateContentParameters) => {
          capturedParams.push(params)
          const next = queued.shift() ?? []
          return { async *[Symbol.asyncIterator]() { for (const c of next) yield c } }
        },
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const tool = defineTool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object' },
      execute: async () => 'data',
    })
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithToolsAndSchema(
        [{ role: 'user', content: 'Tokyo pop?' }],
        [tool],
        citySchema,
      ),
    )
    for (const params of capturedParams) {
      expect(params.config?.responseMimeType).toBe('application/json')
      expect(params.config?.responseJsonSchema).toEqual(citySchema.jsonSchema)
    }
    const stop = events.at(-1)
    expect(stop?.type).toBe('stop')
    if (stop?.type === 'stop') {
      expect(stop.value).toEqual({ city: 'Tokyo', population: 13960000 })
      expect(stop.text).toBe('{"city":"Tokyo","population":13960000}')
      expect(stop.iterations).toBe(1)
    }
  })
})

// ─── BrainManager.streamGenerateWithTools routing ────────────────────────

interface StreamComboCall {
  messages: readonly Message[]
  tools: readonly Tool[]
  schema: OutputSchema<unknown>
  options?: RunWithToolsOptions
}

class StubProvider implements BrainDriver {
  readonly name: string
  readonly calls: StreamComboCall[] = []
  private readonly events: AgentStreamEvent<unknown>[]

  constructor(name: string, events: AgentStreamEvent<unknown>[]) {
    this.name = name
    this.events = events
  }
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
  async *streamWithToolsAndSchema<U>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<U>,
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<U>> {
    this.calls.push({ messages, tools, schema: schema as OutputSchema<unknown>, options })
    for (const e of this.events) yield e as AgentStreamEvent<U>
  }
}

class StubProviderNoCombo implements BrainDriver {
  readonly name = 'no-combo'
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
}

const sampleStop: AgentStreamEvent<Answer> = {
  type: 'stop',
  stopReason: 'end_turn',
  iterations: 0,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  messages: [],
  value: { city: 'X', population: 1 },
  text: '{"city":"X","population":1}',
}

describe('BrainManager.streamGenerateWithTools', () => {
  test('delegates to the default provider', async () => {
    const stub = new StubProvider('stub', [
      { type: 'iteration_start', iteration: 0 },
      sampleStop as AgentStreamEvent<unknown>,
    ])
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const events = await collect(brain.streamGenerateWithTools<Answer>('hi', citySchema, []))
    expect(events.map((e) => e.type)).toEqual(['iteration_start', 'stop'])
    expect(stub.calls).toHaveLength(1)
  })

  test('throws BrainError when the provider lacks streamWithToolsAndSchema', () => {
    const brain = new BrainManager({
      default: 'no-combo',
      providers: { 'no-combo': new StubProviderNoCombo() },
    })
    expect(() => brain.streamGenerateWithTools('hi', citySchema, [])).toThrow(BrainError)
  })

  test('options.provider overrides the default', async () => {
    const a = new StubProvider('a', [sampleStop as AgentStreamEvent<unknown>])
    const b = new StubProvider('b', [sampleStop as AgentStreamEvent<unknown>])
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    await collect(brain.streamGenerateWithTools('hi', citySchema, [], { provider: 'b' }))
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(1)
  })
})

// ─── AgentRunner.stream() with .output(schema) ───────────────────────────

class CityAgent extends Agent {
  override readonly instructions = 'You only emit verified city data.'
  override readonly tier = 'fast'
}

class CityAgentWithTool extends CityAgent {
  override readonly tools: readonly Tool[] = [
    defineTool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    }),
  ]
}

describe('AgentRunner.stream() — schema combined', () => {
  test('schema-only agent streams events; terminal stop carries value', async () => {
    const stub = new StubProvider('stub', [
      { type: 'iteration_start', iteration: 0 },
      { type: 'text', delta: '{"city":"X","population":1}' },
      sampleStop as AgentStreamEvent<unknown>,
    ])
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const events = await collect(
      brain.agent(CityAgent).input('q').output(citySchema).stream(),
    )
    expect(events.map((e) => e.type)).toEqual(['iteration_start', 'text', 'stop'])
    const stop = events.at(-1)
    if (stop?.type === 'stop') {
      expect(stop.value).toEqual({ city: 'X', population: 1 })
    }
    expect(stub.calls[0]?.options?.system).toBe('You only emit verified city data.')
  })

  test('tools-declaring agent also flows through streamGenerateWithTools', async () => {
    const stub = new StubProvider('stub', [sampleStop as AgentStreamEvent<unknown>])
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    await collect(
      brain.agent(CityAgentWithTool).input('q').output(citySchema).stream(),
    )
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.tools).toHaveLength(1)
    expect(stub.calls[0]?.tools[0]?.name).toBe('lookup')
  })
})
