/**
 * `AnthropicProvider` tests — exercise the shape translation between
 * framework types (`Message`, `ChatOptions`, `SystemPrompt`) and the
 * Anthropic SDK's `MessageCreateParams` / `Message` shapes.
 *
 * The real `Anthropic` client is replaced by a stub that records the
 * params passed in and returns a canned response. No network access
 * required.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import type { StreamEvent } from '../src/types.ts'

// ─── Fake SDK client ──────────────────────────────────────────────────────

interface ChatCall {
  params: Anthropic.MessageCreateParams
}

interface CountCall {
  params: Anthropic.MessageCountTokensParams
}

function makeMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 5,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

interface StreamEventStub {
  type: 'content_block_delta'
  delta: { type: 'text_delta'; text: string }
}

function makeFakeStream(deltas: string[], finalMessage: Anthropic.Message) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEventStub> {
      for (const d of deltas) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: d } }
      }
    },
    async finalMessage(): Promise<Anthropic.Message> {
      return finalMessage
    },
  }
}

function makeFakeClient(replyText = 'hello', deltas: string[] = ['hel', 'lo']) {
  const chatCalls: ChatCall[] = []
  const countCalls: CountCall[] = []
  const reply = makeMessage(replyText)
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        chatCalls.push({ params })
        return reply
      },
      stream: (params: Anthropic.MessageCreateParams) => {
        chatCalls.push({ params })
        return makeFakeStream(deltas, reply)
      },
      countTokens: async (params: Anthropic.MessageCountTokensParams) => {
        countCalls.push({ params })
        return { input_tokens: 42 } as Anthropic.MessageTokensCount
      },
    },
  } as unknown as Anthropic
  return { client, chatCalls, countCalls, reply }
}

function makeProvider(client?: Anthropic) {
  return new AnthropicProvider(
    'anthropic',
    { driver: 'anthropic', apiKey: 'sk-test', defaultModel: 'claude-opus-4-7' },
    client !== undefined ? { client } : {},
  )
}

// ─── chat — translation in / out ─────────────────────────────────────────

describe('AnthropicProvider — chat() request shape', () => {
  test('wraps a string-content message as-is', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'hi' }])
    expect(chatCalls).toHaveLength(1)
    const params = chatCalls[0]?.params
    expect(params?.model).toBe('claude-opus-4-7')
    expect(params?.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('translates content blocks with cache flag → text + cache_control', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'shared preamble', cache: true },
          { type: 'text', text: 'volatile question' },
        ],
      },
    ])
    const blocks = chatCalls[0]?.params.messages[0]?.content as Anthropic.TextBlockParam[]
    expect(blocks[0]).toEqual({
      type: 'text',
      text: 'shared preamble',
      cache_control: { type: 'ephemeral' },
    })
    expect(blocks[1]).toEqual({ type: 'text', text: 'volatile question' })
  })

  test('plain string system prompt is forwarded verbatim', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { system: 'be helpful' })
    expect(chatCalls[0]?.params.system).toBe('be helpful')
  })

  test('cached system prompt → TextBlockParam[] with cache_control', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      system: { text: 'large system prompt', cache: true },
    })
    expect(chatCalls[0]?.params.system).toEqual([
      { type: 'text', text: 'large system prompt', cache_control: { type: 'ephemeral' } },
    ])
  })

  test('multi-block system prompt with mixed cache flags', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      system: [
        { text: 'stable prefix', cache: true },
        { text: 'volatile suffix' },
      ],
    })
    expect(chatCalls[0]?.params.system).toEqual([
      { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile suffix' },
    ])
  })

  test("thinking 'adaptive' maps to ThinkingConfigAdaptive", async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { thinking: 'adaptive' })
    expect(chatCalls[0]?.params.thinking).toEqual({ type: 'adaptive' })
  })

  test("thinking 'disabled' maps to ThinkingConfigDisabled", async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { thinking: 'disabled' })
    expect(chatCalls[0]?.params.thinking).toEqual({ type: 'disabled' })
  })

  test('omitted thinking → no thinking field on the request', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(chatCalls[0]?.params.thinking).toBeUndefined()
  })

  test('effort lands under output_config', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { effort: 'high' })
    expect(chatCalls[0]?.params.output_config).toEqual({ effort: 'high' })
  })

  test('cache: true sets top-level cache_control', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { cache: true })
    expect(
      (chatCalls[0]?.params as { cache_control?: { type: string } }).cache_control,
    ).toEqual({ type: 'ephemeral' })
  })

  test('per-call betas merge with provider betas, dedupe preserving order', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = new AnthropicProvider(
      'anthropic',
      {
        driver: 'anthropic',
        apiKey: 'sk-test',
        betas: ['provider-beta', 'shared'],
      },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }], { betas: ['call-beta', 'shared'] })
    const betas = (chatCalls[0]?.params as { betas?: readonly string[] }).betas
    expect(betas).toEqual(['provider-beta', 'shared', 'call-beta'])
  })

  test('maxTokens override beats the provider default', async () => {
    const { client, chatCalls } = makeFakeClient()
    const provider = new AnthropicProvider(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test', defaultMaxTokens: 1000 },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }], { maxTokens: 5000 })
    expect(chatCalls[0]?.params.max_tokens).toBe(5000)
  })
})

// ─── chat — response translation ─────────────────────────────────────────

describe('AnthropicProvider — chat() response shape', () => {
  test('flattens text blocks into ChatResult.text', async () => {
    const { client } = makeFakeClient('hello world')
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.text).toBe('hello world')
  })

  test('surfaces cache hit/miss tokens in usage', async () => {
    const { client } = makeFakeClient()
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 30,
    })
  })

  test('preserves the raw SDK Message on result.raw', async () => {
    const { client } = makeFakeClient()
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect((result.raw as Anthropic.Message).stop_reason).toBe('end_turn')
  })
})

// ─── stream() ────────────────────────────────────────────────────────────

describe('AnthropicProvider — stream()', () => {
  test('yields a text event per delta then a final stop event', async () => {
    const { client } = makeFakeClient('hello', ['hel', 'lo'])
    const provider = makeProvider(client)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream([{ role: 'user', content: 'q' }])) {
      events.push(ev)
    }
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ type: 'text', delta: 'hel' })
    expect(events[1]).toEqual({ type: 'text', delta: 'lo' })
    expect(events[2]?.type).toBe('stop')
  })

  test('final stop event carries stopReason + usage with cache fields', async () => {
    const { client } = makeFakeClient()
    const provider = makeProvider(client)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream([{ role: 'user', content: 'q' }])) {
      events.push(ev)
    }
    const stop = events[events.length - 1]
    expect(stop?.type).toBe('stop')
    if (stop?.type !== 'stop') throw new Error('expected stop event')
    expect(stop.stopReason).toBe('end_turn')
    expect(stop.usage.cacheReadTokens).toBe(5)
  })
})

// ─── countTokens() ───────────────────────────────────────────────────────

describe('AnthropicProvider — countTokens()', () => {
  test('passes the model + messages + system to the SDK and returns input_tokens', async () => {
    const { client, countCalls } = makeFakeClient()
    const provider = makeProvider(client)
    const tokens = await provider.countTokens([{ role: 'user', content: 'q' }], {
      system: 'be helpful',
    })
    expect(tokens).toBe(42)
    expect(countCalls[0]?.params.model).toBe('claude-opus-4-7')
    expect(countCalls[0]?.params.system).toBe('be helpful')
  })
})
