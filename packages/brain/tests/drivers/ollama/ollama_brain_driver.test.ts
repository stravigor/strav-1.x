/**
 * `OllamaBrainDriver` tests — verifies the divergences from
 * `OpenAIBrainDriver`:
 *
 *   - Default base URL (localhost:11434/v1) + default apiKey
 *     ('ollama') applied via the inherited constructor.
 *   - buildParams strips `reasoning_effort`.
 *   - generate uses response_format.json_object + system-prompt
 *     schema injection + client-side parse.
 *   - runWithToolsAndSchema / streamWithToolsAndSchema work via the
 *     OpenAICompatBrainDriver tool-forcing pattern (synthetic
 *     respond_with_* tool whose parameters = schema.jsonSchema).
 *   - Inherits chat / runWithTools unchanged.
 */

import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'
import { BrainError } from "../../../src/brain_error.ts"
import { defineTool } from "../../../src/define_tool.ts"
import type { OutputSchema } from "../../../src/output_schema.ts"
import { OllamaBrainDriver } from "../../../src/drivers/ollama/ollama_brain_driver.ts"

function makeCompletion(opts: {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason?: string
  model?: string
}): OpenAI.Chat.ChatCompletion {
  return {
    id: 'c', object: 'chat.completion', created: 0, model: opts.model ?? 'llama3.2',
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
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 } },
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

describe('OllamaBrainDriver.buildParams', () => {
  test('reasoning_effort is dropped even when options.thinking / options.effort set it', async () => {
    const { client, calls } = makeFakeClient([makeCompletion({ content: 'ok' })])
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }], { effort: 'high', thinking: 'adaptive' })
    expect((calls[0]?.params as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined()
  })
})

// ─── Defaults ────────────────────────────────────────────────────────────

describe('OllamaBrainDriver — defaults', () => {
  test('uses configured defaultModel', async () => {
    const { client, calls } = makeFakeClient([makeCompletion({ content: 'ok' })])
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'qwen2.5' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(calls[0]?.params.model).toBe('qwen2.5')
  })

  test('apiKey defaults to "ollama" (no env var needed)', () => {
    // Construction shouldn't throw on missing apiKey — the SDK is
    // happy with our placeholder.
    expect(
      () =>
        new OllamaBrainDriver('ollama', {
          driver: 'ollama',
          defaultModel: 'llama3.2',
        }),
    ).not.toThrow()
  })
})

// ─── generate ────────────────────────────────────────────────────────────

describe('OllamaBrainDriver.generate', () => {
  test('sets response_format.json_object and injects schema into the system prompt', async () => {
    const { client, calls } = makeFakeClient([
      makeCompletion({ content: '{"city":"Paris","population":2148000}' }),
    ])
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
      { client },
    )
    const result = await provider.generate(
      [{ role: 'user', content: 'Capital of France?' }],
      citySchema,
      { system: 'You only emit verified city data.' },
    )
    expect(result.value).toEqual({ city: 'Paris', population: 2148000 })

    const params = calls[0]?.params as OpenAI.Chat.ChatCompletionCreateParams
    expect(params.response_format).toEqual({ type: 'json_object' })

    const sys = params.messages[0]
    expect(sys?.role).toBe('system')
    const sysContent = typeof sys?.content === 'string' ? sys.content : ''
    expect(sysContent).toContain('You only emit verified city data.')
    expect(sysContent).toContain('JSON object that matches the following JSON Schema')
    expect(sysContent).toContain('"city"')
  })

  test('parse failures wrap as BrainError with raw text on context', async () => {
    const { client } = makeFakeClient([makeCompletion({ content: 'not json' })])
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
      { client },
    )
    let thrown: unknown
    try {
      await provider.generate([{ role: 'user', content: 'q' }], citySchema)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).context).toMatchObject({
      schema: 'city_answer',
      text: 'not json',
    })
  })
})

// ─── runWithToolsAndSchema via tool-forcing ──────────────────────────────

describe('OllamaBrainDriver — runWithToolsAndSchema (tool-forcing)', () => {
  test('respond_with_<schema> call args parse into result.value', async () => {
    const { client, calls } = makeFakeClient([
      makeCompletion({
        toolCalls: [
          {
            id: 'final',
            name: 'respond_with_city_answer',
            arguments: '{"city":"Berlin","population":3700000}',
          },
        ],
        finishReason: 'tool_calls',
      }),
    ])
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
      { client },
    )
    const result = await provider.runWithToolsAndSchema!(
      [{ role: 'user', content: 'q' }],
      [],
      citySchema,
    )
    expect(result.value).toEqual({ city: 'Berlin', population: 3700000 })
    const sentTools = calls[0]?.params.tools as Array<{ function?: { name: string } }>
    expect(sentTools.some((t) => t.function?.name === 'respond_with_city_answer')).toBe(true)
  })

  test('model emits text without calling respond_with → BrainError', async () => {
    const { client } = makeFakeClient([
      makeCompletion({ content: 'Berlin', finishReason: 'stop' }),
    ])
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
      { client },
    )
    await expect(
      provider.runWithToolsAndSchema!([{ role: 'user', content: 'q' }], [], citySchema),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

// ─── Inherits runWithTools ───────────────────────────────────────────────

describe('OllamaBrainDriver — inherits runWithTools', () => {
  test('plain tool-loop flows through the inherited OpenAI loop', async () => {
    const queue = [
      makeCompletion({
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"x":1}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion({ content: 'done', finishReason: 'stop' }),
    ]
    const { client } = makeFakeClient(queue)
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
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
  })
})
