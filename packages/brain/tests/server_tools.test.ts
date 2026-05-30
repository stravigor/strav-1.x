/**
 * Server-side tools tests — verifies that `ChatOptions.serverTools`
 * translates correctly into each provider's native tool entries.
 *
 * Coverage matrix:
 *                  Anthropic       Gemini          OpenAI/DeepSeek/Ollama
 *   web_search     web_search_*    googleSearch    throws
 *   code_execution code_execution_*codeExecution   throws
 *   web_fetch      web_fetch_*     throws          throws
 *   url_context    throws          urlContext      throws
 *
 * The "throws" cases assert BrainError with vendor-specific
 * remediation guidance — apps don't get a wire-level 400.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { BrainError } from '../src/brain_error.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { DeepSeekBrainDriver } from '../src/drivers/deepseek/deepseek_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OllamaBrainDriver } from '../src/drivers/ollama/ollama_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'

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

describe('AnthropicBrainDriver — serverTools translation', () => {
  test('web_search becomes web_search_20260209 with domain caps + max_uses', async () => {
    const { client, calls } = makeAnthropicClient()
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat(
      [{ role: 'user', content: 'What is the weather?' }],
      {
        serverTools: [
          { type: 'web_search', maxUses: 3, allowedDomains: ['weather.gov'] },
        ],
      },
    )
    const tools = calls[0]?.params.tools as Array<{ type: string; name?: string; max_uses?: number; allowed_domains?: string[] }>
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 3,
      allowed_domains: ['weather.gov'],
    })
  })

  test('code_execution becomes code_execution_20260120', async () => {
    const { client, calls } = makeAnthropicClient()
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat(
      [{ role: 'user', content: 'compute primes < 100' }],
      { serverTools: [{ type: 'code_execution' }] },
    )
    const tools = calls[0]?.params.tools as Array<{ type: string; name?: string }>
    expect(tools[0]).toEqual({ type: 'code_execution_20260120', name: 'code_execution' })
  })

  test('web_fetch becomes web_fetch_20260309', async () => {
    const { client, calls } = makeAnthropicClient()
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat(
      [{ role: 'user', content: 'fetch this article' }],
      { serverTools: [{ type: 'web_fetch', maxUses: 2 }] },
    )
    const tools = calls[0]?.params.tools as Array<{ type: string; name?: string; max_uses?: number }>
    expect(tools[0]).toEqual({ type: 'web_fetch_20260309', name: 'web_fetch', max_uses: 2 })
  })

  test('url_context throws BrainError (Gemini-only)', async () => {
    const { client } = makeAnthropicClient()
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await expect(
      provider.chat([{ role: 'user', content: 'x' }], {
        serverTools: [{ type: 'url_context' }],
      }),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

// ─── Gemini ──────────────────────────────────────────────────────────────

function makeGeminiClient() {
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

describe('GeminiBrainDriver — serverTools translation', () => {
  test('web_search → googleSearch (config knobs silently dropped)', async () => {
    const { client, calls } = makeGeminiClient()
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat(
      [{ role: 'user', content: 'weather?' }],
      { serverTools: [{ type: 'web_search', maxUses: 5, allowedDomains: ['weather.gov'] }] },
    )
    const tools = calls[0]?.params.config?.tools as Array<{ googleSearch?: object }>
    expect(tools[0]).toEqual({ googleSearch: {} })
  })

  test('code_execution → codeExecution', async () => {
    const { client, calls } = makeGeminiClient()
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat(
      [{ role: 'user', content: 'compute' }],
      { serverTools: [{ type: 'code_execution' }] },
    )
    const tools = calls[0]?.params.config?.tools as Array<{ codeExecution?: object }>
    expect(tools[0]).toEqual({ codeExecution: {} })
  })

  test('url_context → urlContext', async () => {
    const { client, calls } = makeGeminiClient()
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    await provider.chat(
      [{ role: 'user', content: 'summarize URL' }],
      { serverTools: [{ type: 'url_context' }] },
    )
    const tools = calls[0]?.params.config?.tools as Array<{ urlContext?: object }>
    expect(tools[0]).toEqual({ urlContext: {} })
  })

  test('web_fetch throws BrainError (Anthropic-only)', async () => {
    const { client } = makeGeminiClient()
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    await expect(
      provider.chat([{ role: 'user', content: 'x' }], {
        serverTools: [{ type: 'web_fetch' }],
      }),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('combines with framework-local tools — both arrive in config.tools', async () => {
    const { client, calls } = makeGeminiClient()
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client },
    )
    const tool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    }
    await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { serverTools: [{ type: 'web_search' }] },
    )
    const tools = calls[0]?.params.config?.tools as Array<{ functionDeclarations?: unknown[]; googleSearch?: object }>
    expect(tools).toHaveLength(2)
    expect(tools[0]?.functionDeclarations).toBeDefined()
    expect(tools[1]).toEqual({ googleSearch: {} })
  })
})

// ─── OpenAI / DeepSeek / Ollama throw ───────────────────────────────────

function makeOpenAIClient() {
  return {
    chat: {
      completions: {
        create: async () => ({}) as never,
      },
    },
  } as unknown as OpenAI
}

describe('OpenAIBrainDriver — serverTools throw', () => {
  test('throws with Responses API guidance', async () => {
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client: makeOpenAIClient() },
    )
    let thrown: unknown
    try {
      await provider.chat([{ role: 'user', content: 'q' }], {
        serverTools: [{ type: 'web_search' }],
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).message).toContain('Responses API')
  })
})

describe('DeepSeekBrainDriver — serverTools throw (inherited)', () => {
  test('throws via the inherited OpenAI buildParams', async () => {
    const provider = new DeepSeekBrainDriver(
      'deepseek',
      { driver: 'deepseek', apiKey: 'sk-test' },
      { client: makeOpenAIClient() },
    )
    await expect(
      provider.chat([{ role: 'user', content: 'q' }], {
        serverTools: [{ type: 'code_execution' }],
      }),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

describe('OllamaBrainDriver — serverTools throw (inherited)', () => {
  test('throws via the inherited OpenAI buildParams', async () => {
    const provider = new OllamaBrainDriver(
      'ollama',
      { driver: 'ollama', defaultModel: 'llama3.2' },
      { client: makeOpenAIClient() },
    )
    await expect(
      provider.chat([{ role: 'user', content: 'q' }], {
        serverTools: [{ type: 'web_search' }],
      }),
    ).rejects.toBeInstanceOf(BrainError)
  })
})
