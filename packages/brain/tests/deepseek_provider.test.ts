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
 *   - `runWithToolsAndSchema` / `streamWithToolsAndSchema` throw
 *     `BrainError` (combined tools+schema deferred).
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

// ─── Combined schema methods throw ───────────────────────────────────────

describe('DeepSeekProvider — combined schema methods throw', () => {
  test('runWithToolsAndSchema throws', async () => {
    const { client } = makeFakeClient([])
    const provider = new DeepSeekProvider(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await expect(
      provider.runWithToolsAndSchema!([{ role: 'user', content: 'q' }], [], citySchema),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('streamWithToolsAndSchema throws on first iteration', async () => {
    const { client } = makeFakeClient([])
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
