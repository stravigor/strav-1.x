/**
 * `DeepSeekProvider` tests — covers the divergences from
 * `OpenAIProvider`:
 *
 *   - Default base URL + model.
 *   - `buildParams` strips `reasoning_effort` (would 400 against
 *     DeepSeek's chat-completions endpoint otherwise).
 *   - `generate` uses `response_format.json_object` and injects
 *     the JSON Schema into the system prompt; client-side
 *     `parseGenerated` validates the result.
 *   - `runWithToolsAndSchema` / `streamWithToolsAndSchema` use the
 *     tool-forcing pattern (synthetic `respond_with_*` tool whose
 *     parameters = schema.jsonSchema; model's args become the
 *     parsed value).
 *   - Inherits all OpenAI-compatible behavior — chat() / runWithTools()
 *     work identically by passing through.
 */

import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'
import { BrainError } from '../src/brain_error.ts'
import { defineTool } from '../src/define_tool.ts'
import type { OutputSchema } from '../src/output_schema.ts'
import { DeepSeekProvider } from '../src/providers/deepseek_provider.ts'

function makeCompletion(opts: {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason?: string
}): OpenAI.Chat.ChatCompletion {
  return {
    id: 'c', object: 'chat.completion', created: 0, model: 'deepseek-chat',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: opts.content ?? null, refusal: null,
        tool_calls: opts.toolCalls?.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      },
      finish_reason: opts.finishReason ?? 'stop',
      logprobs: null,
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 } },
  } as unknown as OpenAI.Chat.ChatCompletion
}

function makeFakeClient(responses: OpenAI.Chat.ChatCompletion[]) {
  const calls: Array<{ params: OpenAI.Chat.ChatCompletionCreateParams }> = []
  const queue = [...responses]
  const client = {
    chat: {
      completions: {
        create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
          calls.push({ params })
          const next = queue.shift()
          if (!next) throw new Error('test: no canned responses left')
          return next
        },
      },
    },
  } as unknown as OpenAI
  return { client, calls }
}

interface Answer {
  city: string
  population: number
}

const citySchema: OutputSchema<Answer> = {
  name: 'city_answer',
  description: 'A city + its current population.',
  jsonSchema: {
    type: 'object',
    properties: { city: { type: 'string' }, population: { type: 'integer' } },
    required: ['city', 'population'],
    additionalProperties: false,
  },
}

// ─── buildParams strips reasoning_effort ─────────────────────────────────

describe('DeepSeekProvider.buildParams', () => {
  test('reasoning_effort is dropped even when options.thinking / options.effort set it', async () => {
    const { client, calls } = makeFakeClient([makeCompletion({ content: 'ok' })])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }], { effort: 'high' })
    const params = calls[0]?.params as { reasoning_effort?: unknown }
    expect(params?.reasoning_effort).toBeUndefined()
  })
})

// ─── Default base URL + model ────────────────────────────────────────────

describe('DeepSeekProvider — defaults', () => {
  test('defaultModel = deepseek-chat when not overridden', async () => {
    const { client, calls } = makeFakeClient([makeCompletion({ content: 'ok' })])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(calls[0]?.params.model).toBe('deepseek-chat')
  })

  test('config.defaultModel overrides', async () => {
    const { client, calls } = makeFakeClient([makeCompletion({ content: 'ok' })])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test', defaultModel: 'deepseek-reasoner' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(calls[0]?.params.model).toBe('deepseek-reasoner')
  })
})

// ─── generate uses json_object + system-injected schema ──────────────────

describe('DeepSeekProvider.generate', () => {
  test('sets response_format.json_object and prepends schema instructions to the system prompt', async () => {
    const { client, calls } = makeFakeClient([
      makeCompletion({ content: '{"city":"Paris","population":2148000}' }),
    ])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.generate(
      [{ role: 'user', content: 'Capital of France?' }],
      citySchema,
      { system: 'You only emit verified city data.' },
    )
    expect(result.value).toEqual({ city: 'Paris', population: 2148000 })
    expect(result.text).toBe('{"city":"Paris","population":2148000}')

    const params = calls[0]?.params as OpenAI.Chat.ChatCompletionCreateParams
    expect(params.response_format).toEqual({ type: 'json_object' })

    // First message is the augmented system prompt.
    const sys = params.messages[0]
    expect(sys?.role).toBe('system')
    const sysContent = typeof sys?.content === 'string' ? sys.content : ''
    expect(sysContent).toContain('You only emit verified city data.')
    expect(sysContent).toContain('JSON object that matches the following JSON Schema')
    expect(sysContent).toContain('"city"')
  })

  test('parse failures wrap as BrainError with raw text on context', async () => {
    const { client } = makeFakeClient([makeCompletion({ content: 'not json' })])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    let thrown: unknown
    try {
      await provider.generate(
        [{ role: 'user', content: 'q' }],
        citySchema,
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).context).toMatchObject({ schema: 'city_answer', text: 'not json' })
  })
})

// ─── runWithToolsAndSchema — tool-forcing ────────────────────────────────

describe('DeepSeekProvider — runWithToolsAndSchema (tool-forcing)', () => {
  test('model calls respond_with_<schema> → args become parsed value', async () => {
    const { client, calls } = makeFakeClient([
      makeCompletion({
        toolCalls: [
          {
            id: 'call_final',
            name: 'respond_with_city_answer',
            arguments: '{"city":"Paris","population":2102650}',
          },
        ],
        finishReason: 'tool_calls',
      }),
    ])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.runWithToolsAndSchema!(
      [{ role: 'user', content: 'capital of France?' }],
      [],
      citySchema,
    )
    expect(result.value).toEqual({ city: 'Paris', population: 2102650 })
    // The synthetic tool was injected into the request.
    const sentTools = calls[0]?.params.tools as Array<{ function?: { name: string } }>
    expect(sentTools).toBeDefined()
    expect(sentTools.some((t) => t.function?.name === 'respond_with_city_answer')).toBe(true)
  })

  test('regular tools run first, then respond_with terminates the loop', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'looks up info',
      inputSchema: { type: 'object' },
      execute: async () => 'Paris has 2.1M people',
    })
    const { client } = makeFakeClient([
      makeCompletion({
        toolCalls: [{ id: 'a', name: 'lookup', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion({
        toolCalls: [
          {
            id: 'b',
            name: 'respond_with_city_answer',
            arguments: '{"city":"Paris","population":2100000}',
          },
        ],
        finishReason: 'tool_calls',
      }),
    ])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.runWithToolsAndSchema!(
      [{ role: 'user', content: 'q' }],
      [lookup],
      citySchema,
    )
    expect(result.value).toEqual({ city: 'Paris', population: 2100000 })
    expect(result.iterations).toBe(1)
  })

  test('user tool named respond_with_<schema> → BrainError on collision', async () => {
    const collide = defineTool({
      name: 'respond_with_city_answer',
      description: 'x',
      inputSchema: { type: 'object' },
      execute: async () => 'x',
    })
    const { client } = makeFakeClient([])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await expect(
      provider.runWithToolsAndSchema!(
        [{ role: 'user', content: 'q' }],
        [collide],
        citySchema,
      ),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('model returns plain text without calling respond_with → BrainError', async () => {
    const { client } = makeFakeClient([
      makeCompletion({ content: 'Paris', finishReason: 'stop' }),
    ])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await expect(
      provider.runWithToolsAndSchema!(
        [{ role: 'user', content: 'q' }],
        [],
        citySchema,
      ),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

describe('DeepSeekProvider — streamWithToolsAndSchema (tool-forcing)', () => {
  test('streams text then a terminal stop event carrying value + text', async () => {
    // Simulate a single iteration where the model emits a respond_with
    // tool call (no plain text content).
    const streamEvents = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_final',
                  type: 'function',
                  function: {
                    name: 'respond_with_city_answer',
                    arguments: '{"city":"Paris",',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"population":2100000}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]
    const client = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              for (const e of streamEvents) yield e
            },
          }),
        },
      },
    } as unknown as OpenAI
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    const events: Array<Record<string, unknown>> = []
    for await (const e of provider.streamWithToolsAndSchema!(
      [{ role: 'user', content: 'q' }],
      [],
      citySchema,
    )) {
      events.push(e as unknown as Record<string, unknown>)
    }
    const stop = events.find((e) => e.type === 'stop') as {
      value: Answer
      text: string
    }
    expect(stop.value).toEqual({ city: 'Paris', population: 2100000 })
    // tool_use_start / tool_use_delta should NOT have been emitted
    // for the synthetic respond_with tool — apps shouldn't see it
    // in the stream as a normal tool call.
    expect(events.some((e) => e.type === 'tool_use_start')).toBe(false)
    expect(events.some((e) => e.type === 'tool_use_delta')).toBe(false)
  })

  test('stream that never calls respond_with throws BrainError', async () => {
    const streamEvents = [
      {
        choices: [{ index: 0, delta: { content: 'just text' }, finish_reason: null }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
    const client = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              for (const e of streamEvents) yield e
            },
          }),
        },
      },
    } as unknown as OpenAI
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    let thrown: unknown
    try {
      for await (const _e of provider.streamWithToolsAndSchema!(
        [{ role: 'user', content: 'q' }],
        [],
        citySchema,
      )) {
        // drain
      }
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
  })
})

// ─── Inherits runWithTools (no special override needed) ──────────────────

describe('DeepSeekProvider — inherits runWithTools end-to-end', () => {
  test('plain tool-loop flows through the inherited OpenAI loop', async () => {
    const queue = [
      makeCompletion({
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"x":1}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion({ content: 'done', finishReason: 'stop' }),
    ]
    const { client, calls } = makeFakeClient(queue)
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      execute: async (input: { x: number }) => `got ${input.x}`,
    })
    const result = await provider.runWithTools([{ role: 'user', content: 'go' }], [tool])
    expect(result.text).toBe('done')
    expect(result.iterations).toBe(1)
    // Two model calls in the loop, both with reasoning_effort suppressed.
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect((c.params as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined()
    }
  })
})
