/**
 * Tool-error recovery tests — `options.onToolError`.
 *
 * Covers:
 *   - Default (no callback): execute throws → loop throws
 *     ToolExecutionError. Same behavior as pre-slice.
 *   - Callback returns string → loop continues; tool_result lands
 *     with `isError: true`; next model call sees it.
 *   - Callback returns undefined → loop throws (per-error filtering).
 *   - "Tool not registered" path also routes through the callback.
 *   - OpenAI's JSON-parse-arguments error path also recovers.
 *   - Streaming: `tool_result` event carries `isError: true` and
 *     the loop continues.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { GenerateContentResponse } from '@google/genai'
import type OpenAI from 'openai'
import type { AgentStreamEvent } from '../src/agent_stream_event.ts'
import { defineTool } from '../src/define_tool.ts'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import { GeminiProvider } from '../src/providers/gemini_provider.ts'
import { OpenAIProvider } from '../src/providers/openai_provider.ts'
import { ToolExecutionError } from '../src/tool_execution_error.ts'

async function collect<T>(it: AsyncIterable<AgentStreamEvent<T>>): Promise<AgentStreamEvent<T>[]> {
  const out: AgentStreamEvent<T>[] = []
  for await (const e of it) out.push(e)
  return out
}

// ─── Anthropic — default vs recovery ─────────────────────────────────────

function makeAnthropicMessage(opts: {
  text?: string
  toolUses?: Array<{ id: string; name: string; input: unknown }>
  stopReason: string
}): Anthropic.Message {
  const content: Array<
    | { type: 'text'; text: string; citations: null }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  > = []
  if (opts.text) content.push({ type: 'text', text: opts.text, citations: null })
  for (const u of opts.toolUses ?? []) {
    content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input })
  }
  return {
    id: 'm', type: 'message', role: 'assistant', model: 'claude',
    content, stop_reason: opts.stopReason, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Message
}

describe('Anthropic — onToolError', () => {
  test('without callback, execute throws → loop aborts with ToolExecutionError', async () => {
    const queue = [
      makeAnthropicMessage({
        toolUses: [{ id: 't1', name: 'fails', input: {} }],
        stopReason: 'tool_use',
      }),
    ]
    const client = {
      messages: { create: async () => queue.shift() as Anthropic.Message },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'fails',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => { throw new Error('boom') },
    })
    const provider = new AnthropicProvider(
      'anthropic', { driver: 'anthropic', apiKey: 'sk-test' }, { client },
    )
    await expect(
      provider.runWithTools([{ role: 'user', content: 'go' }], [tool]),
    ).rejects.toBeInstanceOf(ToolExecutionError)
  })

  test('callback returns string → loop continues, next model call sees isError tool_result', async () => {
    const sentMessages: Anthropic.MessageCreateParams['messages'][] = []
    const queue: Anthropic.Message[] = [
      makeAnthropicMessage({
        toolUses: [{ id: 't1', name: 'fails', input: {} }],
        stopReason: 'tool_use',
      }),
      makeAnthropicMessage({ text: 'ok, gave up', stopReason: 'end_turn' }),
    ]
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          sentMessages.push(params.messages)
          return queue.shift() as Anthropic.Message
        },
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'fails',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => { throw new Error('boom') },
    })
    const captured: ToolExecutionError[] = []
    const provider = new AnthropicProvider(
      'anthropic', { driver: 'anthropic', apiKey: 'sk-test' }, { client },
    )
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'go' }],
      [tool],
      { onToolError: (e) => { captured.push(e); return `failed: ${(e.cause as Error).message}` } },
    )
    expect(result.text).toBe('ok, gave up')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.context.tool).toBe('fails')
    // Second call's messages include the user-role tool_result with is_error.
    const secondCallUserTurn = sentMessages[1]?.at(-1)
    const blocks = secondCallUserTurn?.content as Array<{ type: string; is_error?: boolean; content?: string }>
    const errBlock = blocks.find((b) => b.type === 'tool_result')
    expect(errBlock?.is_error).toBe(true)
    expect(errBlock?.content).toContain('failed: boom')
  })

  test('callback returns undefined → loop throws', async () => {
    const queue = [
      makeAnthropicMessage({
        toolUses: [{ id: 't1', name: 'fails', input: {} }],
        stopReason: 'tool_use',
      }),
    ]
    const client = {
      messages: { create: async () => queue.shift() as Anthropic.Message },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'fails',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => { throw new Error('boom') },
    })
    const provider = new AnthropicProvider(
      'anthropic', { driver: 'anthropic', apiKey: 'sk-test' }, { client },
    )
    await expect(
      provider.runWithTools(
        [{ role: 'user', content: 'go' }],
        [tool],
        { onToolError: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError)
  })

  test('"tool not registered" routes through the callback', async () => {
    const queue: Anthropic.Message[] = [
      makeAnthropicMessage({
        toolUses: [{ id: 't1', name: 'ghost', input: {} }],
        stopReason: 'tool_use',
      }),
      makeAnthropicMessage({ text: 'apologies', stopReason: 'end_turn' }),
    ]
    const client = {
      messages: { create: async () => queue.shift() as Anthropic.Message },
    } as unknown as Anthropic
    const captured: ToolExecutionError[] = []
    const provider = new AnthropicProvider(
      'anthropic', { driver: 'anthropic', apiKey: 'sk-test' }, { client },
    )
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'go' }],
      [],
      { onToolError: (e) => { captured.push(e); return `unknown tool: ${e.context.tool}` } },
    )
    expect(result.text).toBe('apologies')
    expect(captured[0]?.context.tool).toBe('ghost')
  })
})

// ─── OpenAI — JSON-parse-args path also recovers ─────────────────────────

function makeOpenAICompletion(opts: {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason: string
}): OpenAI.Chat.ChatCompletion {
  return {
    id: 'c', object: 'chat.completion', created: 0, model: 'gpt-5',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: opts.content ?? null, refusal: null,
        tool_calls: opts.toolCalls?.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      },
      finish_reason: opts.finishReason, logprobs: null,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 } },
  } as unknown as OpenAI.Chat.ChatCompletion
}

describe('OpenAI — onToolError handles JSON-parse-args failures', () => {
  test('malformed tool arguments recover through the callback', async () => {
    const queue = [
      makeOpenAICompletion({
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{ not valid json' }],
        finishReason: 'tool_calls',
      }),
      makeOpenAICompletion({ content: 'sorry, retry?', finishReason: 'stop' }),
    ]
    const client = {
      chat: { completions: { create: async () => queue.shift() as OpenAI.Chat.ChatCompletion } },
    } as unknown as OpenAI
    const tool = defineTool({
      name: 'echo',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const captured: ToolExecutionError[] = []
    const provider = new OpenAIProvider(
      'openai', { driver: 'openai', apiKey: 'sk-test' }, { client },
    )
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'go' }],
      [tool],
      { onToolError: (e) => { captured.push(e); return 'parse failed' } },
    )
    expect(result.text).toBe('sorry, retry?')
    expect(captured[0]?.context.tool).toBe('echo')
    expect((captured[0]?.cause as Error)?.message).toContain('Failed to parse tool input JSON')
  })
})

// ─── Gemini — recovery in the runWithTools loop ──────────────────────────

function makeGeminiResponse(opts: {
  text?: string
  functionCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>
  finishReason: string
}): GenerateContentResponse {
  const parts: Array<{ text?: string; functionCall?: { id?: string; name: string; args: Record<string, unknown> } }> = []
  if (opts.text) parts.push({ text: opts.text })
  for (const fc of opts.functionCalls ?? []) parts.push({ functionCall: fc })
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: opts.finishReason }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
  } as unknown as GenerateContentResponse
}

describe('Gemini — onToolError', () => {
  test('execute throws → callback string surfaces as isError functionResponse next turn', async () => {
    const queue: GenerateContentResponse[] = [
      makeGeminiResponse({
        functionCalls: [{ id: 'c1', name: 'fails', args: {} }],
        finishReason: 'STOP',
      }),
      makeGeminiResponse({ text: 'cannot complete', finishReason: 'STOP' }),
    ]
    const seenContents: unknown[] = []
    const client = {
      models: {
        generateContent: async (params: { contents?: unknown }) => {
          seenContents.push(params.contents)
          return queue.shift() as GenerateContentResponse
        },
        generateContentStream: async () => ({ async *[Symbol.asyncIterator]() {} }),
        countTokens: async () => ({ totalTokens: 0 }),
      },
    }
    const tool = defineTool({
      name: 'fails',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => { throw new Error('boom') },
    })
    const provider = new GeminiProvider(
      'google', { driver: 'google', apiKey: 'sk-test' }, { client },
    )
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'go' }],
      [tool],
      { onToolError: (e) => `tool blew up: ${(e.cause as Error).message}` },
    )
    expect(result.text).toBe('cannot complete')
    // Second turn's contents include a functionResponse with response.error
    const secondTurn = seenContents[1] as Array<{ role: string; parts: Array<{ functionResponse?: { response?: { error?: string; result?: string } } }> }>
    const userTurn = secondTurn.at(-1)
    const errPart = userTurn?.parts.find((p) => p.functionResponse)
    expect(errPart?.functionResponse?.response?.error).toContain('tool blew up: boom')
  })
})

// ─── Streaming — tool_result event carries isError, loop continues ──────

describe('streamWithTools — tool_result event has isError, loop continues', () => {
  test('Anthropic', async () => {
    const queue = [
      { deltas: [] as string[], final: makeAnthropicMessage({
        toolUses: [{ id: 't1', name: 'fails', input: {} }],
        stopReason: 'tool_use',
      }) },
      { deltas: [], final: makeAnthropicMessage({ text: 'recovered', stopReason: 'end_turn' }) },
    ]
    const client = {
      messages: {
        stream: () => {
          const next = queue.shift()!
          return {
            async *[Symbol.asyncIterator]() {
              for (const d of next.deltas) {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: d } }
              }
            },
            async finalMessage() { return next.final },
          }
        },
      },
    } as unknown as Anthropic
    const tool = defineTool({
      name: 'fails',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => { throw new Error('boom') },
    })
    const provider = new AnthropicProvider(
      'anthropic', { driver: 'anthropic', apiKey: 'sk-test' }, { client },
    )
    const events = await collect(
      provider.streamWithTools(
        [{ role: 'user', content: 'go' }],
        [tool],
        { onToolError: () => 'recovered content' },
      ),
    )
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true)
      expect(toolResult.content).toBe('recovered content')
    }
    const stop = events.at(-1)
    expect(stop?.type).toBe('stop')
    if (stop?.type === 'stop') {
      expect(stop.iterations).toBe(1)
    }
  })
})
