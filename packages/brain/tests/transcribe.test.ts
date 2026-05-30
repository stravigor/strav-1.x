/**
 * `BrainManager.transcribe` + per-provider impls.
 *
 * Coverage:
 *   - OpenAI: client.audio.transcriptions.create with the right
 *     file + model + signal; surface text + language + duration
 *     when present.
 *   - Gemini: wraps chat() with an AudioBlock and "transcribe
 *     verbatim" system prompt.
 *   - Ollama: inherits OpenAI's impl through the compat path.
 *   - DeepSeek: throws BrainError.
 *   - Anthropic: BrainManager.transcribe throws when routed
 *     there (provider doesn't implement).
 *   - signal flows; language + prompt forwarded to the SDK on
 *     OpenAI / into the system prompt on Gemini.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { BrainError } from '../src/brain_error.ts'
import { BrainManager } from '../src/brain_manager.ts'
import { DeepSeekBrainDriver } from '../src/drivers/deepseek/deepseek_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OllamaBrainDriver } from '../src/drivers/ollama/ollama_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'

// A minimal valid base64 audio payload (ID3 header). The bytes
// don't matter — none of the tests dial a real API.
const FAKE_AUDIO = 'SUQzBAAAAAA='

// ─── OpenAI ──────────────────────────────────────────────────────────────

describe('OpenAIBrainDriver.transcribe', () => {
  test('forwards file (with right extension), model, language, prompt, signal', async () => {
    const calls: Array<{
      params: OpenAI.Audio.TranscriptionCreateParams
      opts: unknown
    }> = []
    const client = {
      audio: {
        transcriptions: {
          create: async (params: OpenAI.Audio.TranscriptionCreateParams, opts: unknown) => {
            calls.push({ params, opts })
            return { text: 'hello there', language: 'en', duration: 1.42 } as unknown as OpenAI.Audio.TranscriptionCreateResponse
          },
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const ac = new AbortController()
    const result = await provider.transcribe(
      { type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO },
      { language: 'en', prompt: 'speakers: alice, bob', signal: ac.signal },
    )

    expect(result.text).toBe('hello there')
    expect(result.language).toBe('en')
    expect(result.duration).toBe(1.42)
    expect(result.model).toBe('whisper-1')

    const params = calls[0]?.params as OpenAI.Audio.TranscriptionCreateParams
    expect(params.model).toBe('whisper-1')
    expect(params.language).toBe('en')
    expect(params.prompt).toBe('speakers: alice, bob')
    // File: name ends with .mp3 + type mirrors the source MIME.
    const file = params.file as File
    expect(file.type).toBe('audio/mp3')
    expect(file.name).toBe('audio.mp3')
    expect(calls[0]?.opts).toEqual({ signal: ac.signal })
  })

  test('text-only response (gpt-4o-transcribe path) returns text without language/duration', async () => {
    const client = {
      audio: {
        transcriptions: {
          create: async () => ({ text: 'just text' }) as unknown as OpenAI.Audio.TranscriptionCreateResponse,
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test', defaultTranscribeModel: 'gpt-4o-transcribe' },
      { client },
    )
    const result = await provider.transcribe({
      type: 'base64',
      mediaType: 'audio/wav',
      data: FAKE_AUDIO,
    })
    expect(result.text).toBe('just text')
    expect(result.language).toBeUndefined()
    expect(result.duration).toBeUndefined()
    expect(result.model).toBe('gpt-4o-transcribe')
  })

  test('options.model overrides defaultTranscribeModel', async () => {
    const calls: Array<{ params: OpenAI.Audio.TranscriptionCreateParams }> = []
    const client = {
      audio: {
        transcriptions: {
          create: async (params: OpenAI.Audio.TranscriptionCreateParams) => {
            calls.push({ params })
            return { text: 'x' } as unknown as OpenAI.Audio.TranscriptionCreateResponse
          },
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    await provider.transcribe(
      { type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO },
      { model: 'gpt-4o-mini-transcribe' },
    )
    expect(calls[0]?.params.model).toBe('gpt-4o-mini-transcribe')
  })
})

// ─── Gemini (chat-wrap) ─────────────────────────────────────────────────

describe('GeminiBrainDriver.transcribe', () => {
  test('wraps chat() with AudioBlock + "transcribe verbatim" system prompt', async () => {
    const calls: Array<{ params: GenerateContentParameters }> = []
    const client = {
      models: {
        generateContent: async (params: GenerateContentParameters) => {
          calls.push({ params })
          return {
            candidates: [{ content: { role: 'model', parts: [{ text: 'verbatim transcript' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
          } as unknown as GenerateContentResponse
        },
        generateContentStream: async () => ({ async *[Symbol.asyncIterator]() {} }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.transcribe(
      { type: 'base64', mediaType: 'audio/wav', data: FAKE_AUDIO },
      { language: 'fr', prompt: 'medical terminology' },
    )

    expect(result.text).toBe('verbatim transcript')

    const params = calls[0]!.params
    // System prompt mentions transcribe verbatim + language + prompt.
    const sys = params.config?.systemInstruction as string
    expect(sys).toContain('Transcribe the attached audio verbatim')
    expect(sys).toContain('Audio language: fr')
    expect(sys).toContain('medical terminology')
    // Contents include the AudioBlock as inlineData.
    const contents = params.contents as Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>
    expect(contents[0]?.parts[0]?.inlineData).toEqual({
      mimeType: 'audio/wav',
      data: FAKE_AUDIO,
    })
  })
})

// ─── Ollama (inherits OpenAI) ───────────────────────────────────────────

describe('OllamaBrainDriver.transcribe', () => {
  test('inherits OpenAI transcribe via the compat layer', async () => {
    const calls: Array<{ params: OpenAI.Audio.TranscriptionCreateParams }> = []
    const client = {
      audio: {
        transcriptions: {
          create: async (params: OpenAI.Audio.TranscriptionCreateParams) => {
            calls.push({ params })
            return { text: 'local whisper output' } as unknown as OpenAI.Audio.TranscriptionCreateResponse
          },
        },
      },
    } as unknown as OpenAI
    const provider = new OllamaBrainDriver(
      'ollama',
      {
        driver: 'ollama',
        defaultModel: 'llama3.2',
        defaultTranscribeModel: 'whisper',
      },
      { client },
    )
    const result = await provider.transcribe({
      type: 'base64',
      mediaType: 'audio/ogg',
      data: FAKE_AUDIO,
    })
    expect(result.text).toBe('local whisper output')
    expect(calls[0]?.params.model).toBe('whisper')
  })
})

// ─── DeepSeek (throws) ───────────────────────────────────────────────────

describe('DeepSeekBrainDriver.transcribe', () => {
  test('throws BrainError — DeepSeek has no audio API', async () => {
    const client = {} as unknown as OpenAI
    const provider = new DeepSeekBrainDriver(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await expect(
      provider.transcribe({ type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO }),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

// ─── BrainManager routing ───────────────────────────────────────────────

describe('BrainManager.transcribe', () => {
  test('routes to the default provider', async () => {
    const client = {
      audio: {
        transcriptions: {
          create: async () => ({ text: 'ok' }) as unknown as OpenAI.Audio.TranscriptionCreateResponse,
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const brain = new BrainManager({ default: 'openai', providers: { openai: provider } })
    const result = await brain.transcribe({
      type: 'base64',
      mediaType: 'audio/mp3',
      data: FAKE_AUDIO,
    })
    expect(result.text).toBe('ok')
  })

  test('throws BrainError when routed to Anthropic (no impl)', async () => {
    const client = {
      messages: { create: async () => ({}) as never },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const brain = new BrainManager({ default: 'anthropic', providers: { anthropic: provider } })
    await expect(
      brain.transcribe({ type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO }),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('options.provider overrides the default', async () => {
    const callsA: number[] = []
    const callsB: number[] = []
    function mk(name: string, calls: number[]) {
      const client = {
        audio: {
          transcriptions: {
            create: async () => {
              calls.push(1)
              return { text: name } as unknown as OpenAI.Audio.TranscriptionCreateResponse
            },
          },
        },
      } as unknown as OpenAI
      return new OpenAIBrainDriver(name, { driver: 'openai', apiKey: 'sk-test' }, { client })
    }
    const brain = new BrainManager({
      default: 'a',
      providers: { a: mk('a', callsA), b: mk('b', callsB) },
    })
    await brain.transcribe(
      { type: 'base64', mediaType: 'audio/mp3', data: FAKE_AUDIO },
      { provider: 'b' },
    )
    expect(callsA).toHaveLength(0)
    expect(callsB).toHaveLength(1)
  })
})
