/**
 * Multimodal / image-input tests — verifies that `ImageBlock`s in
 * `Message.content` translate correctly into each provider's
 * native wire shape (Anthropic `image`, OpenAI `image_url`,
 * Gemini `inlineData` / `fileData`).
 *
 * Provider tests stub the SDK client and assert the params the
 * SDK would have seen. No actual image bytes needed — `data` is
 * a fake placeholder.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import { GeminiProvider } from '../src/providers/gemini_provider.ts'
import { OpenAIProvider } from '../src/providers/openai_provider.ts'
import type { Message } from '../src/types.ts'

const FAKE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// ─── Anthropic ───────────────────────────────────────────────────────────

describe('AnthropicProvider — ImageBlock translation', () => {
  function makeFakeClient() {
    const calls: Array<{ params: Anthropic.MessageCreateParams }> = []
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          calls.push({ params })
          return {
            id: 'm', type: 'message', role: 'assistant', model: 'claude',
            content: [{ type: 'text', text: 'ok', citations: null }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          } as unknown as Anthropic.Message
        },
      },
    } as unknown as Anthropic
    return { client, calls }
  }

  test('base64 image translates to Anthropic image block with media_type + data', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_BASE64 } },
      ],
    }
    await provider.chat([message])

    const content = calls[0]?.params.messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({ type: 'text', text: 'What is this?' })
      expect(content[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: FAKE_BASE64 },
      })
    }
  })

  test('url image translates to Anthropic image block with url source', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        ],
      },
    ])

    const content = calls[0]?.params.messages[0]?.content as Array<{ type: string; source?: { type: string; url?: string } }>
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.png' },
    })
  })
})

// ─── OpenAI ──────────────────────────────────────────────────────────────

describe('OpenAIProvider — ImageBlock translation', () => {
  function makeFakeClient() {
    const calls: Array<{ params: OpenAI.Chat.ChatCompletionCreateParams }> = []
    const client = {
      chat: {
        completions: {
          create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
            calls.push({ params })
            return {
              id: 'c', object: 'chat.completion', created: 0, model: 'gpt-5',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok', refusal: null }, finish_reason: 'stop', logprobs: null }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 } },
            } as unknown as OpenAI.Chat.ChatCompletion
          },
        },
      },
    } as unknown as OpenAI
    return { client, calls }
  }

  test('base64 image becomes image_url with data: URI', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Caption' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: FAKE_BASE64 } },
        ],
      },
    ])

    const msg = calls[0]?.params.messages[0] as OpenAI.Chat.ChatCompletionUserMessageParam
    expect(Array.isArray(msg.content)).toBe(true)
    if (Array.isArray(msg.content)) {
      expect(msg.content[0]).toEqual({ type: 'text', text: 'Caption' })
      expect(msg.content[1]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${FAKE_BASE64}` },
      })
    }
  })

  test('url image becomes image_url with the raw URL', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        ],
      },
    ])

    const msg = calls[0]?.params.messages[0] as OpenAI.Chat.ChatCompletionUserMessageParam
    if (Array.isArray(msg.content)) {
      expect(msg.content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/cat.png' },
      })
    }
  })

  test('text-only message stays as a string (backward compat)', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      { role: 'user', content: [{ type: 'text', text: 'just text' }] },
    ])

    const msg = calls[0]?.params.messages[0] as OpenAI.Chat.ChatCompletionUserMessageParam
    expect(msg.content).toBe('just text')
  })
})

// ─── Gemini ──────────────────────────────────────────────────────────────

describe('GeminiProvider — ImageBlock translation', () => {
  function makeFakeClient() {
    const calls: Array<{ params: GenerateContentParameters }> = []
    const client = {
      models: {
        generateContent: async (params: GenerateContentParameters) => {
          calls.push({ params })
          return {
            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
          } as unknown as GenerateContentResponse
        },
        generateContentStream: async () => ({ async *[Symbol.asyncIterator]() {} }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    return { client, calls }
  }

  test('base64 image becomes inlineData', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new GeminiProvider(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FAKE_BASE64 } },
        ],
      },
    ])

    const contents = calls[0]?.params.contents as Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>
    const parts = contents[0]!.parts
    expect(parts[0]).toEqual({ text: 'What' })
    expect(parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: FAKE_BASE64 },
    })
  })

  test('url image becomes fileData (mime guessed from extension)', async () => {
    const { client, calls } = makeFakeClient()
    const provider = new GeminiProvider(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.webp' } },
        ],
      },
    ])

    const contents = calls[0]?.params.contents as Array<{ parts: Array<{ text?: string; fileData?: { fileUri: string; mimeType: string } }> }>
    const parts = contents[0]!.parts
    expect(parts[1]).toEqual({
      fileData: { fileUri: 'https://example.com/cat.webp', mimeType: 'image/webp' },
    })
  })
})
