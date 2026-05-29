/**
 * Tool-argument streaming tests — verifies that `streamWithTools`
 * surfaces `tool_use_start` + `tool_use_delta` events for
 * Anthropic + OpenAI as the model composes a tool call. The
 * existing `tool_use` event still fires (post-execution, with
 * parsed input) as the source-of-truth.
 *
 * Gemini doesn't stream tool arguments (parts arrive complete);
 * apps relying on `tool_use_start` / `tool_use_delta` on Gemini
 * see nothing until the final `tool_use` event. Documented; not
 * tested here.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import type { AgentStreamEvent } from '../src/agent_stream_event.ts'
import { defineTool } from '../src/define_tool.ts'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import { OpenAIProvider } from '../src/providers/openai_provider.ts'

async function collect<T>(it: AsyncIterable<AgentStreamEvent<T>>): Promise<AgentStreamEvent<T>[]> {
  const out: AgentStreamEvent<T>[] = []
  for await (const e of it) out.push(e)
  return out
}

// ─── Anthropic ───────────────────────────────────────────────────────────

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
    id: 'm', type: 'message', role: 'assistant', model: 'claude',
    content, stop_reason: opts.stopReason, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Message
}

// Synthesizes the SDK's stream-event shape: content_block_start
// for the tool_use block, then input_json_delta chunks, then
// content_block_stop. `finalMessage` returns the assembled view.
function makeAnthropicStreamWithToolUse(opts: {
  toolUseStart: { index: number; id: string; name: string }
  argsChunks: string[]
  finalMessage: Anthropic.Message
}) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_start',
        index: opts.toolUseStart.index,
        content_block: {
          type: 'tool_use',
          id: opts.toolUseStart.id,
          name: opts.toolUseStart.name,
          input: {},
        },
      }
      for (const chunk of opts.argsChunks) {
        yield {
          type: 'content_block_delta',
          index: opts.toolUseStart.index,
          delta: { type: 'input_json_delta', partial_json: chunk },
        }
      }
      yield { type: 'content_block_stop', index: opts.toolUseStart.index }
    },
    async finalMessage() {
      return opts.finalMessage
    },
  }
}

describe('Anthropic — tool_use_start + tool_use_delta', () => {
  test('emits tool_use_start once + tool_use_delta per partial_json chunk', async () => {
    const queue = [
      {
        argsChunks: ['{"q":', '"current state', ' of bun.sql"}'],
        final: makeAnthropicMessage({
          toolUses: [{ id: 't1', name: 'search', input: { q: 'current state of bun.sql' } }],
          stopReason: 'tool_use',
        }),
      },
      { argsChunks: [], final: makeAnthropicMessage({ text: 'done', stopReason: 'end_turn' }) },
    ]
    const client = {
      messages: {
        stream: () => {
          const next = queue.shift()!
          // Second turn has no tool_use — return a plain stream with
          // no content events and the final 'done' message.
          if (next.argsChunks.length === 0) {
            return {
              async *[Symbol.asyncIterator]() {},
              async finalMessage() {
                return next.final
              },
            }
          }
          return makeAnthropicStreamWithToolUse({
            toolUseStart: { index: 0, id: 't1', name: 'search' },
            argsChunks: next.argsChunks,
            finalMessage: next.final,
          })
        },
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'search',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    })
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'go' }], [tool]),
    )

    const starts = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use_start' }> => e.type === 'tool_use_start',
    )
    expect(starts).toEqual([{ type: 'tool_use_start', id: 't1', name: 'search' }])

    const deltas = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use_delta' }> => e.type === 'tool_use_delta',
    )
    expect(deltas.map((d) => d.argsDelta).join('')).toBe('{"q":"current state of bun.sql"}')
    expect(deltas.every((d) => d.id === 't1')).toBe(true)

    // tool_use still fires with the final parsed input.
    const toolUse = events.find(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use' }> => e.type === 'tool_use',
    )
    expect(toolUse?.input).toEqual({ q: 'current state of bun.sql' })
  })
})

// ─── OpenAI ──────────────────────────────────────────────────────────────

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

describe('OpenAI — tool_use_start + tool_use_delta', () => {
  test('emits tool_use_start once + tool_use_delta per arguments chunk', async () => {
    const turn1: FakeOpenAIChunk[] = [
      // First chunk: id + name arrive together.
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'search' } },
              ],
            },
          },
        ],
      },
      // Args stream over multiple chunks.
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]
    const turn2: FakeOpenAIChunk[] = [
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
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
      name: 'search',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    })
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'go' }], [tool]),
    )

    const starts = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use_start' }> => e.type === 'tool_use_start',
    )
    expect(starts).toEqual([{ type: 'tool_use_start', id: 'call_1', name: 'search' }])

    const deltas = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use_delta' }> => e.type === 'tool_use_delta',
    )
    expect(deltas.map((d) => d.argsDelta).join('')).toBe('{"q":"hello"}')
    expect(deltas.every((d) => d.id === 'call_1')).toBe(true)

    const toolUse = events.find(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use' }> => e.type === 'tool_use',
    )
    expect(toolUse?.input).toEqual({ q: 'hello' })
  })

  test('multiple parallel tool calls in one turn emit distinct ids', async () => {
    const turn1: FakeOpenAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'tool_a' } },
                { index: 1, id: 'call_b', function: { name: 'tool_b' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }] },
    ]
    const turn2: FakeOpenAIChunk[] = [
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ finish_reason: 'stop' }] },
    ]
    const queued = [turn1, turn2]
    const client = {
      chat: { completions: { create: async () => makeOpenAIStream(queued.shift() ?? []) } },
    } as unknown as OpenAI
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const toolA = defineTool({
      name: 'tool_a', description: 'd', inputSchema: { type: 'object' },
      execute: async () => 'a',
    })
    const toolB = defineTool({
      name: 'tool_b', description: 'd', inputSchema: { type: 'object' },
      execute: async () => 'b',
    })
    const events = await collect(
      provider.streamWithTools([{ role: 'user', content: 'go' }], [toolA, toolB]),
    )

    const starts = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use_start' }> => e.type === 'tool_use_start',
    )
    expect(starts.map((s) => s.id)).toEqual(['call_a', 'call_b'])

    const deltas = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'tool_use_delta' }> => e.type === 'tool_use_delta',
    )
    expect(deltas.find((d) => d.id === 'call_a')?.argsDelta).toBe('{"x":1}')
    expect(deltas.find((d) => d.id === 'call_b')?.argsDelta).toBe('{"y":2}')
  })
})
