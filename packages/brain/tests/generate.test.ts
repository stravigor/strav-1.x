/**
 * Structured-output tests — `BrainManager.generate` + per-provider
 * `generate` implementations.
 *
 * Each provider's SDK client is stubbed; tests assert (a) the
 * provider-specific wire shape (Anthropic `output_config.format`,
 * OpenAI `response_format.json_schema`, Gemini `responseJsonSchema`
 * + `responseMimeType`) and (b) round-trip parsing through
 * `parseGenerated` (including the optional `schema.parse` hook).
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { BrainError } from '../src/brain_error.ts'
import { BrainManager } from '../src/brain_manager.ts'
import type { OutputSchema } from '../src/output_schema.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'

// ─── A tiny shared schema reused across providers ────────────────────────

interface Answer {
  city: string
  population: number
}

const cityJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    population: { type: 'integer' },
  },
  required: ['city', 'population'],
  additionalProperties: false,
}

const answerSchema: OutputSchema<Answer> = {
  name: 'city_answer',
  description: 'A city + its current population.',
  jsonSchema: cityJsonSchema,
}

// ─── AnthropicBrainDriver.generate ──────────────────────────────────────────

describe('AnthropicBrainDriver — generate()', () => {
  test('emits output_config.format and parses the JSON response', async () => {
    const captured: { params?: Anthropic.MessageCreateParams } = {}
    const message: Anthropic.Message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: '{"city":"Paris","population":2148000}', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
      },
    } as unknown as Anthropic.Message
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          captured.params = params
          return message
        },
      },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.generate(
      [{ role: 'user', content: 'capital of France?' }],
      answerSchema,
    )
    expect(result.value).toEqual({ city: 'Paris', population: 2148000 })
    expect(result.text).toBe('{"city":"Paris","population":2148000}')
    const params = captured.params as Anthropic.MessageCreateParams & {
      output_config?: { format?: { type: string; schema?: unknown } }
    }
    expect(params.output_config?.format).toEqual({
      type: 'json_schema',
      schema: cityJsonSchema,
    })
  })

  test('runs schema.parse when supplied', async () => {
    let seen: unknown
    const schema: OutputSchema<{ ok: true; v: string }> = {
      name: 's',
      jsonSchema: { type: 'object' },
      parse(raw) {
        seen = raw
        return { ok: true, v: (raw as { v?: string }).v ?? '' }
      },
    }
    const message: Anthropic.Message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: '{"v":"hi"}', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
      },
    } as unknown as Anthropic.Message
    const client = {
      messages: { create: async () => message },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.generate([{ role: 'user', content: 'q' }], schema)
    expect(seen).toEqual({ v: 'hi' })
    expect(result.value).toEqual({ ok: true, v: 'hi' })
  })

  test('invalid JSON in response throws BrainError with raw text on context', async () => {
    const message: Anthropic.Message = {
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'not json', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
      },
    } as unknown as Anthropic.Message
    const client = {
      messages: { create: async () => message },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    let thrown: unknown
    try {
      await provider.generate([{ role: 'user', content: 'q' }], answerSchema)
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

// ─── OpenAIBrainDriver.generate ─────────────────────────────────────────────

describe('OpenAIBrainDriver — generate()', () => {
  function makeOpenAICompletion(text: string): OpenAI.Chat.ChatCompletion {
    return {
      id: 'c_1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text, refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      },
    } as unknown as OpenAI.Chat.ChatCompletion
  }

  test('emits response_format.json_schema and parses the JSON response', async () => {
    let capturedParams: OpenAI.Chat.ChatCompletionCreateParams | undefined
    const client = {
      chat: {
        completions: {
          create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
            capturedParams = params
            return makeOpenAICompletion('{"city":"Berlin","population":3645000}')
          },
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.generate(
      [{ role: 'user', content: 'capital of Germany?' }],
      answerSchema,
    )
    expect(result.value).toEqual({ city: 'Berlin', population: 3645000 })
    expect(capturedParams?.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'city_answer',
        description: 'A city + its current population.',
        schema: cityJsonSchema,
        strict: true,
      },
    })
  })
})

// ─── GeminiBrainDriver.generate ─────────────────────────────────────────────

describe('GeminiBrainDriver — generate()', () => {
  function makeGeminiResponse(text: string): GenerateContentResponse {
    return {
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      modelVersion: 'gemini-2.5-flash-001',
    } as unknown as GenerateContentResponse
  }

  test('emits responseMimeType + responseJsonSchema and parses the JSON', async () => {
    let capturedParams: GenerateContentParameters | undefined
    const client = {
      models: {
        generateContent: async (params: GenerateContentParameters) => {
          capturedParams = params
          return makeGeminiResponse('{"city":"Tokyo","population":13960000}')
        },
        generateContentStream: async () => ({
          async *[Symbol.asyncIterator]() {},
        }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.generate(
      [{ role: 'user', content: 'capital of Japan?' }],
      answerSchema,
    )
    expect(result.value).toEqual({ city: 'Tokyo', population: 13960000 })
    expect(capturedParams?.config?.responseMimeType).toBe('application/json')
    expect(capturedParams?.config?.responseJsonSchema).toEqual(cityJsonSchema)
  })
})

// ─── BrainManager.generate routing ───────────────────────────────────────

describe('BrainManager.generate()', () => {
  test('routes to the default provider', async () => {
    const calls: string[] = []
    const stub = {
      name: 'stub',
      async chat() { return {} as never },
      stream() { return (async function*() {})() },
      async generate<T>() {
        calls.push('stub')
        return { value: { hit: true } as T, text: '{"hit":true}', model: 'stub', stopReason: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, raw: undefined }
      },
    }
    const brain = new BrainManager({ default: 'stub', providers: { stub } })
    const result = await brain.generate('hi', answerSchema)
    expect(calls).toEqual(['stub'])
    expect((result.value as unknown as { hit: boolean }).hit).toBe(true)
  })

  test('options.provider overrides the default', async () => {
    const seen: string[] = []
    function stub(name: string) {
      return {
        name,
        async chat() { return {} as never },
        stream() { return (async function*() {})() },
        async generate<T>() {
          seen.push(name)
          return { value: null as T, text: 'null', model: name, stopReason: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, raw: undefined }
        },
      }
    }
    const brain = new BrainManager({
      default: 'a',
      providers: { a: stub('a'), b: stub('b') },
    })
    await brain.generate('hi', answerSchema, { provider: 'b' })
    expect(seen).toEqual(['b'])
  })

  test('throws BrainError when provider lacks generate', async () => {
    const stub = {
      name: 'no-gen',
      async chat() { return {} as never },
      stream() { return (async function*() {})() },
    }
    const brain = new BrainManager({ default: 'no-gen', providers: { 'no-gen': stub } })
    await expect(brain.generate('hi', answerSchema)).rejects.toBeInstanceOf(BrainError)
  })

  test('applies tier → model resolution before delegating', async () => {
    let seenModel: string | undefined
    const stub = {
      name: 's',
      async chat() { return {} as never },
      stream() { return (async function*() {})() },
      async generate<T>(_messages: readonly unknown[], _schema: OutputSchema<T>, options?: { model?: string }) {
        seenModel = options?.model
        return { value: {} as T, text: '{}', model: options?.model ?? '', stopReason: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, raw: undefined }
      },
    }
    const brain = new BrainManager({
      default: 's',
      providers: { s: stub },
      tiers: { fast: 'flash-x' },
    })
    await brain.generate('hi', answerSchema, { tier: 'fast' })
    expect(seenModel).toBe('flash-x')
  })
})
