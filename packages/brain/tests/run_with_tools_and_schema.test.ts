/**
 * `Provider.runWithToolsAndSchema` + `BrainManager.generateWithTools`
 * + `AgentRunner.run()` with `.output(schema)` AND tools.
 *
 * Verifies that the schema-constraint params are injected into every
 * model call, that the loop still flows through tool execution, and
 * that the final assistant text is parsed via `parseGenerated`.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { Agent } from '../src/agent.ts'
import type { AgentGenerateResult } from '../src/agent_generate_result.ts'
import { BrainError } from '../src/brain_error.ts'
import { BrainManager } from '../src/brain_manager.ts'
import { defineTool } from '../src/define_tool.ts'
import type { OutputSchema } from '../src/output_schema.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'
import type { BrainDriver, RunWithToolsOptions } from '../src/brain_driver.ts'
import type { Tool } from '../src/tool.ts'
import type { ChatOptions, ChatResult, Message, StreamEvent } from '../src/types.ts'

// ─── Shared schema used across providers ─────────────────────────────────

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

// ─── AnthropicBrainDriver.runWithToolsAndSchema ─────────────────────────────

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

describe('AnthropicBrainDriver.runWithToolsAndSchema', () => {
  test('emits output_config.format every turn + parses the final JSON', async () => {
    const queue: Anthropic.Message[] = [
      makeAnthropicMessage({
        toolUses: [{ id: 't1', name: 'lookup', input: { name: 'Paris' } }],
        stopReason: 'tool_use',
      }),
      makeAnthropicMessage({
        text: '{"city":"Paris","population":2148000}',
        stopReason: 'end_turn',
      }),
    ]
    const captured: Anthropic.MessageCreateParams[] = []
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          captured.push(params)
          return queue.shift() as Anthropic.Message
        },
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'lookup',
      description: 'look up a city',
      inputSchema: { type: 'object' },
      execute: async (input: { name: string }) => `data for ${input.name}`,
    })
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.runWithToolsAndSchema(
      [{ role: 'user', content: 'What is the population of Paris?' }],
      [tool],
      citySchema,
    )
    expect(result.value).toEqual({ city: 'Paris', population: 2148000 })
    expect(result.iterations).toBe(1)
    expect(result.stopReason).toBe('end_turn')
    // Both calls carry output_config.format
    for (const params of captured) {
      const p = params as Anthropic.MessageCreateParams & {
        output_config?: { format?: { type: string; schema?: unknown } }
      }
      expect(p.output_config?.format).toEqual({
        type: 'json_schema',
        schema: citySchema.jsonSchema,
      })
    }
  })
})

// ─── OpenAIBrainDriver.runWithToolsAndSchema ────────────────────────────────

function makeOpenAICompletion(opts: {
  text?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason: string
}): OpenAI.Chat.ChatCompletion {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: opts.text ?? null,
          refusal: null,
          tool_calls: opts.toolCalls?.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        },
        finish_reason: opts.finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    },
  } as unknown as OpenAI.Chat.ChatCompletion
}

describe('OpenAIBrainDriver.runWithToolsAndSchema', () => {
  test('injects response_format.json_schema every turn and parses final JSON', async () => {
    const queue: OpenAI.Chat.ChatCompletion[] = [
      makeOpenAICompletion({
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"name":"Berlin"}' }],
        finishReason: 'tool_calls',
      }),
      makeOpenAICompletion({
        text: '{"city":"Berlin","population":3645000}',
        finishReason: 'stop',
      }),
    ]
    const captured: OpenAI.Chat.ChatCompletionCreateParams[] = []
    const client = {
      chat: {
        completions: {
          create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
            captured.push(params)
            return queue.shift() as OpenAI.Chat.ChatCompletion
          },
        },
      },
    } as unknown as OpenAI
    const tool = defineTool({
      name: 'lookup',
      description: 'look up',
      inputSchema: { type: 'object' },
      execute: async () => 'data',
    })
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.runWithToolsAndSchema(
      [{ role: 'user', content: 'Berlin pop?' }],
      [tool],
      citySchema,
    )
    expect(result.value).toEqual({ city: 'Berlin', population: 3645000 })
    expect(result.iterations).toBe(1)
    for (const params of captured) {
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
  })
})

// ─── GeminiBrainDriver.runWithToolsAndSchema ────────────────────────────────

function makeGeminiResponse(opts: {
  text?: string
  functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  finishReason: string
}): GenerateContentResponse {
  const parts: Array<{ text?: string; functionCall?: { id?: string; name: string; args: Record<string, unknown> } }> = []
  if (opts.text) parts.push({ text: opts.text })
  for (const fc of opts.functionCalls ?? []) parts.push({ functionCall: fc })
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: opts.finishReason }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    modelVersion: 'gemini-2.5-flash-001',
  } as unknown as GenerateContentResponse
}

describe('GeminiBrainDriver.runWithToolsAndSchema', () => {
  test('injects responseMimeType + responseJsonSchema every turn and parses final JSON', async () => {
    const queue: GenerateContentResponse[] = [
      makeGeminiResponse({
        functionCalls: [{ id: 'c1', name: 'lookup', args: { name: 'Tokyo' } }],
        finishReason: 'STOP',
      }),
      makeGeminiResponse({
        text: '{"city":"Tokyo","population":13960000}',
        finishReason: 'STOP',
      }),
    ]
    const captured: GenerateContentParameters[] = []
    const client = {
      models: {
        generateContent: async (params: GenerateContentParameters) => {
          captured.push(params)
          return queue.shift() as GenerateContentResponse
        },
        generateContentStream: async () => ({ async *[Symbol.asyncIterator]() {} }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const tool = defineTool({
      name: 'lookup',
      description: 'look up',
      inputSchema: { type: 'object' },
      execute: async () => 'data',
    })
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.runWithToolsAndSchema(
      [{ role: 'user', content: 'Tokyo pop?' }],
      [tool],
      citySchema,
    )
    expect(result.value).toEqual({ city: 'Tokyo', population: 13960000 })
    expect(result.iterations).toBe(1)
    for (const params of captured) {
      expect(params.config?.responseMimeType).toBe('application/json')
      expect(params.config?.responseJsonSchema).toEqual(citySchema.jsonSchema)
    }
  })
})

// ─── BrainManager.generateWithTools routing ──────────────────────────────

interface ComboCall {
  messages: readonly Message[]
  tools: readonly Tool[]
  schema: OutputSchema<unknown>
  options?: RunWithToolsOptions
}

class StubProvider implements BrainDriver {
  readonly name: string
  readonly comboCalls: ComboCall[] = []
  private readonly result: AgentGenerateResult<unknown>

  constructor(name: string, result: AgentGenerateResult<unknown>) {
    this.name = name
    this.result = result
  }
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
  async runWithToolsAndSchema<U>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<U>,
    options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<U>> {
    this.comboCalls.push({ messages, tools, schema: schema as OutputSchema<unknown>, options })
    return this.result as AgentGenerateResult<U>
  }
}

class StubProviderWithoutCombo implements BrainDriver {
  readonly name = 'no-combo'
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
}

const sampleResult: AgentGenerateResult<Answer> = {
  value: { city: 'X', population: 1 },
  text: '{"city":"X","population":1}',
  messages: [],
  iterations: 0,
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
}

describe('BrainManager.generateWithTools', () => {
  test('routes to the configured provider with messages + tools + schema', async () => {
    const stub = new StubProvider('stub', sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    })
    const result = await brain.generateWithTools('hi', citySchema, [tool])
    expect(result.value).toEqual({ city: 'X', population: 1 })
    expect(stub.comboCalls).toHaveLength(1)
    expect(stub.comboCalls[0]?.tools).toEqual([tool])
    expect(stub.comboCalls[0]?.schema).toBe(citySchema)
  })

  test('throws BrainError when the provider lacks runWithToolsAndSchema', async () => {
    const brain = new BrainManager({
      default: 'no-combo',
      providers: { 'no-combo': new StubProviderWithoutCombo() },
    })
    await expect(brain.generateWithTools('hi', citySchema, [])).rejects.toBeInstanceOf(BrainError)
  })

  test('options.provider overrides the default', async () => {
    const a = new StubProvider('a', sampleResult)
    const b = new StubProvider('b', sampleResult)
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    await brain.generateWithTools('hi', citySchema, [], { provider: 'b' })
    expect(a.comboCalls).toHaveLength(0)
    expect(b.comboCalls).toHaveLength(1)
  })

  test('applies tier → model resolution before delegating', async () => {
    const stub = new StubProvider('stub', sampleResult)
    const brain = new BrainManager({
      default: 'stub',
      providers: { stub },
      tiers: { fast: 'fast-model' },
    })
    await brain.generateWithTools('hi', citySchema, [], { tier: 'fast' })
    expect(stub.comboCalls[0]?.options?.model).toBe('fast-model')
  })

  test('falls back to defaultMcpServers when none on the call', async () => {
    const stub = new StubProvider('stub', sampleResult)
    const brain = new BrainManager({
      default: 'stub',
      providers: { stub },
      defaultMcpServers: [{ name: 'linear', url: 'https://mcp.linear.app' }],
    })
    await brain.generateWithTools('hi', citySchema, [])
    expect(stub.comboCalls[0]?.options?.mcpServers).toEqual([
      { name: 'linear', url: 'https://mcp.linear.app' },
    ])
  })
})

// ─── AgentRunner.run() with .output(schema) AND tools ────────────────────

class CityAgentWithTool extends Agent {
  override readonly instructions = 'You only emit verified city data.'
  override readonly tier = 'fast'
  override readonly tools: readonly Tool[] = [
    defineTool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    }),
  ]
}

class CityAgentWithMcp extends Agent {
  override readonly instructions = 'You only emit verified city data.'
  override readonly tier = 'fast'
  override readonly mcpServers = [{ name: 'linear', url: 'https://mcp.linear.app' }]
}

describe('AgentRunner.run() — schema + tools combined', () => {
  test('returns AgentGenerateResult<T> when tools are declared (no throw)', async () => {
    const stub = new StubProvider('stub', sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const result = await brain
      .agent(CityAgentWithTool)
      .input('q')
      .output(citySchema)
      .run()
    expect(result.value).toEqual({ city: 'X', population: 1 })
    expect(stub.comboCalls).toHaveLength(1)
    expect(stub.comboCalls[0]?.tools).toHaveLength(1)
    expect(stub.comboCalls[0]?.tools[0]?.name).toBe('lookup')
    expect(stub.comboCalls[0]?.options?.system).toBe('You only emit verified city data.')
  })

  test('forwards mcpServers from the agent into options', async () => {
    const stub = new StubProvider('stub', sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    await brain.agent(CityAgentWithMcp).input('q').output(citySchema).run()
    expect(stub.comboCalls[0]?.options?.mcpServers).toEqual([
      { name: 'linear', url: 'https://mcp.linear.app' },
    ])
  })

  test('.stream() still throws when .output(schema) is also set', () => {
    const stub = new StubProvider('stub', sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    expect(() =>
      brain.agent(CityAgentWithTool).input('q').output(citySchema).stream(),
    ).toThrow(BrainError)
  })
})

// (chat / countTokens stubs used for type compliance in StubProvider —
//  ChatOptions is imported here purely to keep the test file resilient
//  if those signatures pick up new params in later slices.)
const _unused: ChatOptions = {}
void _unused
