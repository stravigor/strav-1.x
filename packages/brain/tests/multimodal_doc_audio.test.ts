/**
 * Document + audio multimodal tests.
 *
 * Coverage matrix:
 *
 *                   Anthropic   OpenAI       Gemini
 *   DocumentBlock   native      throws       inlineData/fileData
 *   AudioBlock      throws      throws       inlineData/fileData
 *
 * The "throws" tests assert a `BrainError` with a clear
 * remediation message rather than a wire-level 400.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { BrainError } from '../src/brain_error.ts'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import { GeminiProvider } from '../src/providers/gemini_provider.ts'
import { OpenAIProvider } from '../src/providers/openai_provider.ts'
import type { Message } from '../src/types.ts'

const FAKE_PDF = 'JVBERi0xLjQKJfbk/N8K'   // truncated; bytes don't matter for translation tests
const FAKE_AUDIO = 'SUQzBAAAAAA='           // truncated ID3 header

// ─── Anthropic ───────────────────────────────────────────────────────────

function makeAnthropicClient() {
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

describe('AnthropicProvider — DocumentBlock', () => {
  test('base64 PDF translates to native document block with title', async () => {
    const { client, calls } = makeAnthropicClient()
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'Summarize this contract.' },
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PDF },
          title: 'NDA — 2026 Q1',
        },
      ],
    }
    await provider.chat([message])

    const content = calls[0]?.params.messages[0]?.content as Array<{ type: string; title?: string; source?: { type: string; media_type?: string; data?: string } }>
    expect(content[1]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: FAKE_PDF },
      title: 'NDA — 2026 Q1',
    })
  })

  test('url PDF translates to native document block', async () => {
    const { client, calls } = makeAnthropicClient()
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize' },
          {
            type: 'document',
            source: { type: 'url', url: 'https://example.com/contract.pdf' },
          },
        ],
      },
    ])
    const content = calls[0]?.params.messages[0]?.content as Array<{ type: string; source?: { type: string; url?: string } }>
    expect(content[1]).toEqual({
      type: 'document',
      source: { type: 'url', url: 'https://example.com/contract.pdf' },
    })
  })
})

describe('AnthropicProvider — AudioBlock throws', () => {
  test('audio block in a user message throws BrainError with guidance', async () => {
    const { client } = makeAnthropicClient()
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    let thrown: unknown
    try {
      await provider.chat([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe' },
            { type: 'audio', source: { type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO } },
          ],
        },
      ])
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).message).toContain('audio blocks are not supported')
  })
})

// ─── OpenAI throws on both ───────────────────────────────────────────────

describe('OpenAIProvider — DocumentBlock + AudioBlock throw', () => {
  function makeClient() {
    const client = {
      chat: {
        completions: {
          create: async () => ({}) as never,
        },
      },
    } as unknown as OpenAI
    return client
  }

  test('document block throws with split-to-images guidance', async () => {
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client: makeClient() },
    )
    let thrown: unknown
    try {
      await provider.chat([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarize' },
            {
              type: 'document',
              source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PDF },
            },
          ],
        },
      ])
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).message).toContain('split the document to images')
  })

  test('audio block throws with Whisper guidance', async () => {
    const provider = new OpenAIProvider(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client: makeClient() },
    )
    let thrown: unknown
    try {
      await provider.chat([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe' },
            { type: 'audio', source: { type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO } },
          ],
        },
      ])
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).message).toContain('Whisper')
  })
})

// ─── Gemini handles both via inlineData / fileData ──────────────────────

describe('GeminiProvider — DocumentBlock + AudioBlock', () => {
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

  test('base64 PDF → inlineData with application/pdf MIME', async () => {
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
          { type: 'text', text: 'Summarize' },
          {
            type: 'document',
            source: { type: 'base64', mediaType: 'application/pdf', data: FAKE_PDF },
          },
        ],
      },
    ])
    const contents = calls[0]?.params.contents as Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>
    expect(contents[0]!.parts[1]).toEqual({
      inlineData: { mimeType: 'application/pdf', data: FAKE_PDF },
    })
  })

  test('url PDF → fileData with application/pdf MIME (from default)', async () => {
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
          { type: 'text', text: 'Summarize' },
          {
            type: 'document',
            source: { type: 'url', url: 'https://example.com/whatever' },
          },
        ],
      },
    ])
    const contents = calls[0]?.params.contents as Array<{ parts: Array<{ fileData?: { fileUri: string; mimeType: string } }> }>
    expect(contents[0]!.parts[1]?.fileData).toEqual({
      fileUri: 'https://example.com/whatever',
      mimeType: 'application/pdf',
    })
  })

  test('base64 audio → inlineData with audio MIME', async () => {
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
          { type: 'text', text: 'Transcribe' },
          { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: FAKE_AUDIO } },
        ],
      },
    ])
    const contents = calls[0]?.params.contents as Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>
    expect(contents[0]!.parts[1]?.inlineData).toEqual({
      mimeType: 'audio/wav',
      data: FAKE_AUDIO,
    })
  })

  test('url audio → fileData with MIME guessed from extension', async () => {
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
          { type: 'text', text: 'Transcribe' },
          { type: 'audio', source: { type: 'url', url: 'https://cdn.example.com/voice.ogg' } },
        ],
      },
    ])
    const contents = calls[0]?.params.contents as Array<{ parts: Array<{ fileData?: { fileUri: string; mimeType: string } }> }>
    expect(contents[0]!.parts[1]?.fileData).toEqual({
      fileUri: 'https://cdn.example.com/voice.ogg',
      mimeType: 'audio/ogg',
    })
  })
})
