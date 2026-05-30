/**
 * Embeddings tests — `BrainManager.embed` + per-provider impls.
 *
 * Covers:
 *   - OpenAI: client.embeddings.create + result shape.
 *   - Gemini: ai.models.embedContent + result shape (usage = 0
 *     because Gemini doesn't surface embed-token counts).
 *   - Ollama: inherits OpenAI's impl via the OpenAI-compat path.
 *   - DeepSeek: throws BrainError (DeepSeek doesn't have an
 *     embeddings API).
 *   - Anthropic: BrainManager.embed throws when routed there
 *     (provider doesn't implement embed).
 *   - signal flows; dimensions flow; batch via array input.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { BrainError } from '../src/brain_error.ts'
import { BrainManager } from '../src/brain_manager.ts'
import { DeepSeekBrainDriver } from '../src/drivers/deepseek/deepseek_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OllamaBrainDriver } from '../src/drivers/ollama/ollama_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'

// ─── OpenAI ──────────────────────────────────────────────────────────────

function makeOpenAIEmbedResponse(opts: {
  embeddings: number[][]
  model?: string
  promptTokens?: number
}): OpenAI.CreateEmbeddingResponse {
  return {
    object: 'list',
    model: opts.model ?? 'text-embedding-3-small',
    data: opts.embeddings.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    usage: {
      prompt_tokens: opts.promptTokens ?? 5,
      total_tokens: opts.promptTokens ?? 5,
    },
  } as unknown as OpenAI.CreateEmbeddingResponse
}

describe('OpenAIBrainDriver.embed', () => {
  test('forwards model + input + signal to client.embeddings.create', async () => {
    const calls: Array<{ params: OpenAI.EmbeddingCreateParams; opts: unknown }> = []
    const client = {
      embeddings: {
        create: async (params: OpenAI.EmbeddingCreateParams, opts: unknown) => {
          calls.push({ params, opts })
          return makeOpenAIEmbedResponse({ embeddings: [[0.1, 0.2, 0.3]] })
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const ac = new AbortController()
    const result = await provider.embed(['hello'], { signal: ac.signal })

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]])
    expect(result.model).toBe('text-embedding-3-small')
    expect(result.usage.inputTokens).toBe(5)
    expect(calls[0]?.params.model).toBe('text-embedding-3-small')
    expect(calls[0]?.params.input).toEqual(['hello'])
    expect(calls[0]?.opts).toEqual({ signal: ac.signal })
  })

  test('batch input → batch embeddings preserved in order', async () => {
    const client = {
      embeddings: {
        create: async () => makeOpenAIEmbedResponse({ embeddings: [[1], [2], [3]] }),
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const result = await provider.embed(['a', 'b', 'c'])
    expect(result.embeddings).toEqual([[1], [2], [3]])
  })

  test('options.dimensions forwarded as `dimensions`', async () => {
    const calls: Array<{ params: OpenAI.EmbeddingCreateParams }> = []
    const client = {
      embeddings: {
        create: async (params: OpenAI.EmbeddingCreateParams) => {
          calls.push({ params })
          return makeOpenAIEmbedResponse({ embeddings: [[0.5]] })
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    await provider.embed(['x'], { dimensions: 512 })
    expect(calls[0]?.params.dimensions).toBe(512)
  })

  test('options.model overrides defaultEmbedModel', async () => {
    const calls: Array<{ params: OpenAI.EmbeddingCreateParams }> = []
    const client = {
      embeddings: {
        create: async (params: OpenAI.EmbeddingCreateParams) => {
          calls.push({ params })
          return makeOpenAIEmbedResponse({ embeddings: [[0.5]], model: 'text-embedding-3-large' })
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test', defaultEmbedModel: 'text-embedding-3-small' },
      { client },
    )
    await provider.embed(['x'], { model: 'text-embedding-3-large' })
    expect(calls[0]?.params.model).toBe('text-embedding-3-large')
  })
})

// ─── Gemini ──────────────────────────────────────────────────────────────

describe('GeminiBrainDriver.embed', () => {
  test('forwards contents + signal via embedContent; usage = 0', async () => {
    const calls: Array<{ params: unknown }> = []
    const client = {
      models: {
        generateContent: async () => ({}) as never,
        generateContentStream: async () => ({ async *[Symbol.asyncIterator]() {} }),
        countTokens: async () => ({ totalTokens: 0 }),
        embedContent: async (params: unknown) => {
          calls.push({ params })
          return { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }
        },
      },
    }
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const ac = new AbortController()
    const result = await provider.embed(['hello', 'world'], { signal: ac.signal, dimensions: 384 })

    expect(result.embeddings).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(result.model).toBe('text-embedding-004')
    expect(result.usage.inputTokens).toBe(0)

    const params = calls[0]?.params as {
      model: string
      contents: string[]
      config?: { abortSignal?: AbortSignal; outputDimensionality?: number }
    }
    expect(params.model).toBe('text-embedding-004')
    expect(params.contents).toEqual(['hello', 'world'])
    expect(params.config?.abortSignal).toBe(ac.signal)
    expect(params.config?.outputDimensionality).toBe(384)
  })
})

// ─── Ollama (inherits OpenAI's impl) ─────────────────────────────────────

describe('OllamaBrainDriver.embed', () => {
  test('inherits OpenAI embed via the compat layer', async () => {
    const calls: Array<{ params: OpenAI.EmbeddingCreateParams }> = []
    const client = {
      embeddings: {
        create: async (params: OpenAI.EmbeddingCreateParams) => {
          calls.push({ params })
          return makeOpenAIEmbedResponse({
            embeddings: [[0.1, 0.2, 0.3, 0.4]],
            model: 'nomic-embed-text',
          })
        },
      },
    } as unknown as OpenAI
    const provider = new OllamaBrainDriver(
      'ollama',
      {
        driver: 'ollama',
        defaultModel: 'llama3.2',
        defaultEmbedModel: 'nomic-embed-text',
      },
      { client },
    )
    const result = await provider.embed(['hi'])
    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3, 0.4]])
    expect(calls[0]?.params.model).toBe('nomic-embed-text')
  })
})

// ─── DeepSeek (throws) ───────────────────────────────────────────────────

describe('DeepSeekBrainDriver.embed', () => {
  test('throws BrainError — DeepSeek has no embeddings API', async () => {
    const client = {
      embeddings: { create: async () => { throw new Error('should not be called') } },
    } as unknown as OpenAI
    const provider = new DeepSeekBrainDriver(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client },
    )
    await expect(provider.embed(['hi'])).rejects.toBeInstanceOf(BrainError)
  })
})

// ─── BrainManager.embed routing ──────────────────────────────────────────

describe('BrainManager.embed', () => {
  test('routes to the default provider; normalizes string → [string]', async () => {
    const calls: Array<{ input: unknown }> = []
    const client = {
      embeddings: {
        create: async (params: OpenAI.EmbeddingCreateParams) => {
          calls.push({ input: params.input })
          return makeOpenAIEmbedResponse({ embeddings: [[0.7]] })
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    const brain = new BrainManager({ default: 'openai', providers: { openai: provider } })

    const r = await brain.embed('hello')
    expect(r.embeddings).toEqual([[0.7]])
    expect(calls[0]?.input).toEqual(['hello'])
  })

  test('throws BrainError when routed to Anthropic (no embed impl)', async () => {
    const client = {
      messages: { create: async () => { throw new Error('unused') } },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const brain = new BrainManager({ default: 'anthropic', providers: { anthropic: provider } })
    await expect(brain.embed('hi')).rejects.toBeInstanceOf(BrainError)
  })

  test('options.provider overrides the default', async () => {
    const callsA: number[] = []
    const callsB: number[] = []
    const makeProvider = (name: string, calls: number[]) => {
      const client = {
        embeddings: {
          create: async () => {
            calls.push(1)
            return makeOpenAIEmbedResponse({ embeddings: [[0]] })
          },
        },
      } as unknown as OpenAI
      return new OpenAIBrainDriver(name, { driver: 'openai', apiKey: 'sk-test' }, { client })
    }
    const brain = new BrainManager({
      default: 'a',
      providers: { a: makeProvider('a', callsA), b: makeProvider('b', callsB) },
    })
    await brain.embed('hi', { provider: 'b' })
    expect(callsA).toHaveLength(0)
    expect(callsB).toHaveLength(1)
  })
})
