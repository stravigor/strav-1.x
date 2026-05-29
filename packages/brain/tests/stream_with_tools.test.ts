/**
 * `Provider.streamWithTools` + `BrainManager.streamTools` +
 * `AgentRunner.stream()` tests — verify the event vocabulary
 * across all three providers and the manager / runner facades.
 *
 * Stubs the per-provider SDK client so iteration boundaries,
 * tool execution, and the terminal stop shape can be asserted
 * without network.
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
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import { GeminiProvider } from '../src/providers/gemini_provider.ts'
import { OpenAIProvider } from '../src/providers/openai_provider.ts'
import type { Provider, RunWithToolsOptions } from '../src/provider.ts'
import type { Tool } from '../src/tool.ts'
import type { ChatResult, Message, StreamEvent } from '../src/types.ts'

// ─── Shared helpers ──────────────────────────────────────────────────────

async function collect(it: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

// ─── AnthropicProvider.streamWithTools ───────────────────────────────────

function makeAnthropicMessage(opts: {
  text?: string
  toolUses?: Array<{ id: string; name: string; input: unknown }>
  stopReason?: string
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
    stop_reason: opts.stopReason ?? 'end_turn',
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
    async finalMessage() {
      return final
    },
  }
}

describe('AnthropicProvider.streamWithTools', () => {
  test('single iteration → text deltas then stop', async () => {
    const final = makeAnthropicMessage({ text: 'hello world', stopReason: 'end_turn' })
    const client = {
      messages: {
        stream: () => makeAnthropicStream(['hello ', 'world'], final),
      },
    } as unknown as Anthropic
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'hi' }], []),
    )
    expect(events[0]).toEqual({ type: 'iteration_start', iteration: 0 })
    expect(events[1]).toEqual({ type: 'text', delta: 'hello ' })
    expect(events[2]).toEqual({ type: 'text', delta: 'world' })
    expect(events[3]).toMatchObject({ type: 'iteration_end', iteration: 0, stopReason: 'end_turn' })
    const stop = events[4]
    expect(stop?.type).toBe('stop')
    if (stop?.type === 'stop') {
      expect(stop.iterations).toBe(0)
      expect(stop.stopReason).toBe('end_turn')
      expect(stop.usage.inputTokens).toBe(5)
    }
  })

  test('tool_use → tool execution → second iteration → stop', async () => {
    const turn1 = makeAnthropicMessage({
      toolUses: [{ id: 't1', name: 'echo', input: { x: 1 } }],
      stopReason: 'tool_use',
    })
    const turn2 = makeAnthropicMessage({ text: 'done', stopReason: 'end_turn' })
    const queued = [turn1, turn2]
    const client = {
      messages: {
        stream: () => makeAnthropicStream([], queued.shift() as Anthropic.Message),
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'echo',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async (input: { x: number }) => `got ${input.x}`,
    })
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'go' }], [tool]),
    )
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'iteration_start',
      'iteration_end',
      'tool_use',
      'tool_result',
      'iteration_start',
      'iteration_end',
      'stop',
    ])
    const toolUse = events.find((e): e is Extract<AgentStreamEvent, { type: 'tool_use' }> => e.type === 'tool_use')
    expect(toolUse?.input).toEqual({ x: 1 })
    const toolResult = events.find((e): e is Extract<AgentStreamEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    expect(toolResult?.content).toBe('got 1')
    const stop = events.at(-1)
    if (stop?.type === 'stop') {
      expect(stop.iterations).toBe(1)
      expect(stop.stopReason).toBe('end_turn')
    }
  })
})

// ─── OpenAIProvider.streamWithTools ──────────────────────────────────────

interface FakeOpenAIChunk {
  choices?: Array<{
    index?: number
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

describe('OpenAIProvider.streamWithTools', () => {
  test('emits text deltas then a terminal stop', async () => {
    const chunks: FakeOpenAIChunk[] = [
      { choices: [{ delta: { content: 'hi ' } }] },
      { choices: [{ delta: { content: 'there' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ]
    const client = {
      chat: {
        completions: {
          create: async () => makeOpenAIStream(chunks),
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'q' }], []),
    )
    const types = events.map((e) => e.type)
    expect(types).toEqual(['iteration_start', 'text', 'text', 'iteration_end', 'stop'])
    const stop = events.at(-1)
    if (stop?.type === 'stop') {
      expect(stop.stopReason).toBe('stop')
      expect(stop.iterations).toBe(0)
      expect(stop.usage.inputTokens).toBe(4)
    }
  })

  test('streams tool_calls deltas, executes, loops', async () => {
    const turn1: FakeOpenAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'add' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":2' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: ',"b":3}' } }] } },
        ],
      },
      {
        choices: [{ finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 8 },
      },
    ]
    const turn2: FakeOpenAIChunk[] = [
      { choices: [{ delta: { content: '5' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 1 } },
    ]
    const queued = [turn1, turn2]
    const client = {
      chat: {
        completions: {
          create: async () => makeOpenAIStream(queued.shift() ?? []),
        },
      },
    } as unknown as OpenAI
    const tool = defineTool({
      name: 'add',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async (input: { a: number; b: number }) => input.a + input.b,
    })
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'go' }], [tool]),
    )
    const toolUse = events.find((e): e is Extract<AgentStreamEvent, { type: 'tool_use' }> => e.type === 'tool_use')
    expect(toolUse?.input).toEqual({ a: 2, b: 3 })
    const toolResult = events.find((e): e is Extract<AgentStreamEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    expect(toolResult?.content).toBe('5')
    const stop = events.at(-1)
    expect(stop?.type).toBe('stop')
    if (stop?.type === 'stop') {
      expect(stop.iterations).toBe(1)
      expect(stop.stopReason).toBe('stop')
    }
  })
})

// ─── GeminiProvider.streamWithTools ──────────────────────────────────────

function makeGeminiChunk(opts: {
  text?: string
  functionCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>
  finishReason?: string
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number }
}): GenerateContentResponse {
  const parts: Array<{ text?: string; functionCall?: { id?: string; name: string; args: Record<string, unknown> } }> = []
  if (opts.text) parts.push({ text: opts.text })
  for (const fc of opts.functionCalls ?? []) parts.push({ functionCall: fc })
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: opts.finishReason }],
    usageMetadata: opts.usage,
  } as unknown as GenerateContentResponse
}

describe('GeminiProvider.streamWithTools', () => {
  test('text-only single iteration → stop', async () => {
    const chunks = [
      makeGeminiChunk({ text: 'he' }),
      makeGeminiChunk({ text: 'llo', finishReason: 'STOP', usage: { promptTokenCount: 4, candidatesTokenCount: 2 } }),
    ]
    const client = {
      models: {
        generateContent: async () => ({}) as GenerateContentResponse,
        generateContentStream: async () => ({
          async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
        }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const provider = new GeminiProvider(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'q' }], []),
    )
    expect(events.map((e) => e.type)).toEqual([
      'iteration_start',
      'text',
      'text',
      'iteration_end',
      'stop',
    ])
  })

  test('functionCall → tool execution → second iteration → stop', async () => {
    const turn1 = [
      makeGeminiChunk({
        functionCalls: [{ id: 'c1', name: 'echo', args: { x: 1 } }],
        finishReason: 'STOP',
      }),
    ]
    const turn2 = [makeGeminiChunk({ text: 'done', finishReason: 'STOP' })]
    const queued: GenerateContentResponse[][] = [turn1, turn2]
    const client = {
      models: {
        generateContent: async () => ({}) as GenerateContentResponse,
        generateContentStream: async (_params: GenerateContentParameters) => ({
          async *[Symbol.asyncIterator]() {
            const next = queued.shift() ?? []
            for (const c of next) yield c
          },
        }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const tool = defineTool({
      name: 'echo',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async (input: { x: number }) => `got ${input.x}`,
    })
    const provider = new GeminiProvider(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'go' }], [tool]),
    )
    const toolResult = events.find((e): e is Extract<AgentStreamEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    expect(toolResult?.content).toBe('got 1')
    const stop = events.at(-1)
    if (stop?.type === 'stop') {
      expect(stop.iterations).toBe(1)
    }
  })
})

// ─── BrainManager.streamTools routing ────────────────────────────────────

interface StreamCall {
  messages: readonly Message[]
  tools: readonly Tool[]
  options?: RunWithToolsOptions
}

class StubStreamingProvider implements Provider {
  readonly name: string
  readonly calls: StreamCall[] = []
  private readonly events: AgentStreamEvent[]

  constructor(name: string, events: AgentStreamEvent[]) {
    this.name = name
    this.events = events
  }
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
  async *streamWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent> {
    this.calls.push({ messages, tools, options })
    for (const e of this.events) yield e
  }
}

class StubNoStreamingProvider implements Provider {
  readonly name = 'no-stream'
  async chat(): Promise<ChatResult> { throw new Error('chat unused') }
  async *stream(): AsyncIterable<StreamEvent> {}
}

const terminalStop: AgentStreamEvent = {
  type: 'stop',
  stopReason: 'end_turn',
  iterations: 0,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  messages: [],
}

describe('BrainManager.streamTools', () => {
  test('delegates to the default provider', async () => {
    const stub = new StubStreamingProvider('stub', [
      { type: 'iteration_start', iteration: 0 },
      { type: 'text', delta: 'hi' },
      terminalStop,
    ])
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const events = await collect(brain.streamTools('hi', []))
    expect(events.map((e) => e.type)).toEqual(['iteration_start', 'text', 'stop'])
    expect(stub.calls).toHaveLength(1)
  })

  test('throws BrainError when the provider lacks streamWithTools', () => {
    const brain = new BrainManager({
      default: 'no-stream',
      providers: { 'no-stream': new StubNoStreamingProvider() },
    })
    expect(() => brain.streamTools('hi', [])).toThrow(BrainError)
  })

  test('respects options.provider routing', async () => {
    const a = new StubStreamingProvider('a', [terminalStop])
    const b = new StubStreamingProvider('b', [terminalStop])
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    await collect(brain.streamTools('hi', [], { provider: 'b' }))
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(1)
  })
})

// ─── AgentRunner.stream() ────────────────────────────────────────────────

class TestAgent extends Agent {
  override readonly instructions = 'You are a test agent.'
  override readonly tier = 'fast'
}

describe('AgentRunner.stream()', () => {
  test('streams events through the runner', async () => {
    const stub = new StubStreamingProvider('stub', [
      { type: 'iteration_start', iteration: 0 },
      { type: 'text', delta: 'hello' },
      terminalStop,
    ])
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const events = await collect(brain.agent(TestAgent).input('q').stream())
    expect(events.map((e) => e.type)).toEqual(['iteration_start', 'text', 'stop'])
    expect(stub.calls[0]?.options?.system).toBe('You are a test agent.')
  })

  test('throws when input() not called', () => {
    const stub = new StubStreamingProvider('stub', [terminalStop])
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    expect(() => brain.agent(TestAgent).stream()).toThrow(/input\(\) must be called/)
  })

  // The previous "throws when .output(schema) was used" case was
  // removed when streaming + schema combined landed. The happy
  // path moved to stream_with_tools_and_schema.test.ts.
})
