/**
 * `AbortSignal` plumbing tests.
 *
 * Verifies that:
 *   - `options.signal` flows through every provider's SDK request
 *     options (Anthropic + OpenAI) or `config.abortSignal` (Gemini).
 *   - Aborting before a tool-loop iteration throws an `AbortError`
 *     (DOMException) out of the iterator.
 *   - `ToolContext.signal` is populated when the run had a signal.
 *   - `MCPClient.callTool` / `listTools` forward the signal to the
 *     underlying SDK.
 *
 * The "abort" cases assert behavior, not exact error class —
 * Bun's runtime fires either DOMException or AbortError depending
 * on the spec version. Tests check `.name === 'AbortError'`.
 */

import { describe, expect, test } from 'bun:test'
import type { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import type OpenAI from 'openai'
import { defineTool } from '../src/define_tool.ts'
import type { MCPClient as MCPClientType, MCPToolDescriptor } from '../src/mcp/client.ts'
import { MCPClient } from '../src/mcp/client.ts'
import { resolveMcpTools } from '../src/mcp/resolve_mcp_tools.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'

// ─── Signal forwarding — chat() per provider ─────────────────────────────

describe('chat() — forwards options.signal to the SDK', () => {
  test('Anthropic', async () => {
    const captured: Array<{ params: unknown; opts: unknown }> = []
    const client = {
      messages: {
        create: async (params: unknown, opts: unknown) => {
          captured.push({ params, opts })
          return {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            content: [{ type: 'text', text: 'ok', citations: null }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          } as unknown as Anthropic.Message
        },
      },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const ac = new AbortController()
    await provider.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal })
    expect(captured[0]?.opts).toEqual({ signal: ac.signal })
  })

  test('OpenAI', async () => {
    const captured: Array<{ opts: unknown }> = []
    const client = {
      chat: {
        completions: {
          create: async (_params: OpenAI.Chat.ChatCompletionCreateParams, opts: unknown) => {
            captured.push({ opts })
            return {
              id: 'c',
              object: 'chat.completion',
              created: 0,
              model: 'gpt-5',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok', refusal: null }, finish_reason: 'stop', logprobs: null }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 } },
            } as unknown as OpenAI.Chat.ChatCompletion
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
    await provider.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal })
    expect(captured[0]?.opts).toEqual({ signal: ac.signal })
  })

  test('Gemini — sets config.abortSignal', async () => {
    const captured: GenerateContentParameters[] = []
    const client = {
      models: {
        generateContent: async (params: GenerateContentParameters) => {
          captured.push(params)
          return {
            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
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
    const ac = new AbortController()
    await provider.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal })
    expect(captured[0]?.config?.abortSignal).toBe(ac.signal)
  })
})

// ─── Inter-iteration abort — runWithTools ────────────────────────────────

describe('runWithTools — aborting between iterations throws AbortError', () => {
  test('Anthropic', async () => {
    const ac = new AbortController()
    let calls = 0
    const client = {
      messages: {
        create: async () => {
          calls++
          // Abort before the next iteration's check fires.
          ac.abort()
          return {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          } as unknown as Anthropic.Message
        },
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    let thrown: unknown
    try {
      await provider.runWithTools([{ role: 'user', content: 'go' }], [tool], { signal: ac.signal })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { name?: string })?.name).toBe('AbortError')
    // First iteration completed (calls === 1); second iteration check bailed.
    expect(calls).toBe(1)
  })
})

// ─── streamWithTools — abort-mid-iter throws on next-iter check ─────────

describe('streamWithTools — aborting between iterations bails the iterator', () => {
  test('OpenAI', async () => {
    const ac = new AbortController()
    const turn1Chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'noop', arguments: '{}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 0, completion_tokens: 0 } },
    ]
    let createCalls = 0
    const client = {
      chat: {
        completions: {
          create: async () => {
            createCalls++
            // Abort while we're returning the first turn's stream.
            queueMicrotask(() => ac.abort())
            return {
              async *[Symbol.asyncIterator]() { for (const c of turn1Chunks) yield c },
            }
          },
        },
      },
    } as unknown as OpenAI
    const tool = defineTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client },
    )
    let thrown: unknown
    try {
      for await (const _e of provider.streamWithTools(
        [{ role: 'user', content: 'go' }],
        [tool],
        { signal: ac.signal },
      )) {
        // drain
      }
    } catch (e) {
      thrown = e
    }
    expect((thrown as { name?: string })?.name).toBe('AbortError')
    expect(createCalls).toBe(1)
  })
})

// ─── ToolContext.signal is populated ─────────────────────────────────────

describe('ToolContext.signal — tool.execute receives the run signal', () => {
  test('Anthropic propagates signal into ctx', async () => {
    const ac = new AbortController()
    let seenSignal: AbortSignal | undefined
    const tool = defineTool({
      name: 'spy',
      description: 'spy',
      inputSchema: { type: 'object' },
      execute: async (_input, ctx) => {
        seenSignal = ctx.signal
        return 'ok'
      },
    })
    const queue: Anthropic.Message[] = [
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'tool_use', id: 't1', name: 'spy', input: {} }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      } as unknown as Anthropic.Message,
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: 'done', citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      } as unknown as Anthropic.Message,
    ]
    const client = {
      messages: {
        create: async () => queue.shift() as Anthropic.Message,
      },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.runWithTools(
      [{ role: 'user', content: 'go' }],
      [tool],
      { signal: ac.signal },
    )
    expect(seenSignal).toBe(ac.signal)
  })

  test('omitted when no signal provided', async () => {
    let seenSignal: AbortSignal | undefined
    let executed = false
    const tool = defineTool({
      name: 'spy',
      description: 'spy',
      inputSchema: { type: 'object' },
      execute: async (_input, ctx) => {
        seenSignal = ctx.signal
        executed = true
        return 'ok'
      },
    })
    const queue: Anthropic.Message[] = [
      {
        id: 'm1', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'tool_use', id: 't1', name: 'spy', input: {} }],
        stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      } as unknown as Anthropic.Message,
      {
        id: 'm2', type: 'message', role: 'assistant', model: 'claude',
        content: [{ type: 'text', text: 'done', citations: null }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      } as unknown as Anthropic.Message,
    ]
    const client = {
      messages: { create: async () => queue.shift() as Anthropic.Message },
    } as unknown as Anthropic
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    await provider.runWithTools([{ role: 'user', content: 'go' }], [tool], {})
    expect(executed).toBe(true)
    expect(seenSignal).toBeUndefined()
  })
})

// ─── MCPClient signal forwarding ─────────────────────────────────────────

describe('MCPClient — forwards signal to the SDK', () => {
  function makeFakeSdkClient() {
    const calls: Array<{ method: string; opts?: unknown }> = []
    const fake = {
      async connect() {},
      async listTools(_p: unknown, opts?: unknown) {
        calls.push({ method: 'listTools', opts })
        return { tools: [{ name: 'a', description: 'a', inputSchema: { type: 'object' } }] }
      },
      async callTool(_p: unknown, _s: unknown, opts?: unknown) {
        calls.push({ method: 'callTool', opts })
        return { content: [{ type: 'text', text: 'ok' }], isError: false }
      },
      async close() {},
    }
    return { fake, calls }
  }

  test('listTools forwards signal', async () => {
    const { fake, calls } = makeFakeSdkClient()
    const c = new MCPClient(
      { name: 's', url: 'https://x' },
      { client: fake as unknown as SdkClient },
    )
    const ac = new AbortController()
    await c.listTools({ signal: ac.signal })
    expect(calls).toEqual([{ method: 'listTools', opts: { signal: ac.signal } }])
  })

  test('callTool forwards signal', async () => {
    const { fake, calls } = makeFakeSdkClient()
    const c = new MCPClient(
      { name: 's', url: 'https://x' },
      { client: fake as unknown as SdkClient },
    )
    const ac = new AbortController()
    await c.callTool('t', {}, { signal: ac.signal })
    expect(calls.at(-1)).toEqual({ method: 'callTool', opts: { signal: ac.signal } })
  })

  test('resolveMcpTools forwards ctx.signal into callTool', async () => {
    const { fake, calls } = makeFakeSdkClient()
    const c: MCPClientType = new MCPClient(
      { name: 's', url: 'https://x' },
      { client: fake as unknown as SdkClient },
    )
    const resolved = await resolveMcpTools(
      [{ name: 's', url: 'https://x' }],
      { clientFactory: () => c },
    )
    const ac = new AbortController()
    await resolved.tools[0]!.execute({}, { callId: 'cid', context: {}, signal: ac.signal })
    expect(calls.find((c) => c.method === 'callTool')?.opts).toEqual({ signal: ac.signal })
    await resolved.close()
  })

  // Unused import guard — keep typecheck honest on MCPToolDescriptor.
  const _unused: MCPToolDescriptor | undefined = undefined
  void _unused
})
