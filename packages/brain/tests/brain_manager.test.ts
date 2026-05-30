/**
 * `BrainManager` tests. Uses stub `Provider` implementations rather
 * than the real Anthropic SDK so the test suite runs without network
 * access or API keys. The translation between framework shapes and
 * Anthropic's SDK is covered separately in
 * `anthropic_provider.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { BrainManager } from '../src/brain_manager.ts'
import type { BrainDriver } from '../src/brain_driver.ts'
import type { ChatOptions, ChatResult, Message, StreamEvent } from '../src/types.ts'

// ─── Stub provider ───────────────────────────────────────────────────────

interface ChatCall {
  messages: readonly Message[]
  options: ChatOptions | undefined
}

class StubProvider implements BrainDriver {
  readonly name: string
  readonly chatCalls: ChatCall[] = []
  readonly streamCalls: ChatCall[] = []
  countTokensImpl?: (m: readonly Message[]) => Promise<number>

  constructor(name: string, private readonly text = 'stub-reply') {
    this.name = name
  }

  async chat(messages: readonly Message[], options?: ChatOptions): Promise<ChatResult> {
    this.chatCalls.push({ messages, options })
    return {
      text: this.text,
      model: options?.model ?? 'stub-model',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      raw: { stub: true },
    }
  }

  async *stream(
    messages: readonly Message[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent> {
    this.streamCalls.push({ messages, options })
    yield { type: 'text', delta: this.text }
    yield {
      type: 'stop',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }
  }

  async countTokens(messages: readonly Message[]): Promise<number> {
    return this.countTokensImpl ? this.countTokensImpl(messages) : messages.length
  }
}

class StubWithoutCount implements BrainDriver {
  readonly name = 'no-count'
  async chat(): Promise<ChatResult> {
    return {
      text: '',
      model: '',
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      raw: {},
    }
  }
  async *stream(): AsyncIterable<StreamEvent> {}
}

// ─── Construction ────────────────────────────────────────────────────────

describe('BrainManager — construction', () => {
  test('throws when default provider is not registered', () => {
    expect(() => new BrainManager({ default: 'missing', providers: {} })).toThrow(
      /default provider "missing" is not registered/,
    )
  })

  test('binds a provider registry keyed by name', () => {
    const a = new StubProvider('a')
    const b = new StubProvider('b')
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    expect(brain.provider('a')).toBe(a)
    expect(brain.provider('b')).toBe(b)
    expect(brain.provider()).toBe(a) // default
  })

  test('provider() throws when the requested name is not registered', () => {
    const brain = new BrainManager({ default: 'a', providers: { a: new StubProvider('a') } })
    expect(() => brain.provider('missing')).toThrow(/no provider registered under "missing"/)
  })
})

// ─── chat() ──────────────────────────────────────────────────────────────

describe('BrainManager — chat()', () => {
  test('wraps a bare prompt string into a single user-role message', async () => {
    const a = new StubProvider('a', 'hi')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    const result = await brain.chat('hello')
    expect(result.text).toBe('hi')
    expect(a.chatCalls).toHaveLength(1)
    expect(a.chatCalls[0]?.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  test('passes through a multi-turn Message[] verbatim', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    const messages: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]
    await brain.chat(messages)
    expect(a.chatCalls[0]?.messages).toEqual(messages)
  })

  test('resolves tier sugar to the configured model', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({
      default: 'a',
      providers: { a },
      tiers: { fast: 'haiku', balanced: 'sonnet', powerful: 'opus' },
    })
    await brain.chat('q', { tier: 'fast' })
    expect(a.chatCalls[0]?.options?.model).toBe('haiku')
  })

  test('explicit options.model wins over tier', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({
      default: 'a',
      providers: { a },
      tiers: { fast: 'haiku', balanced: 'sonnet', powerful: 'opus' },
    })
    await brain.chat('q', { tier: 'fast', model: 'custom' })
    expect(a.chatCalls[0]?.options?.model).toBe('custom')
  })

  test('routes to options.provider when set', async () => {
    const a = new StubProvider('a', 'from-a')
    const b = new StubProvider('b', 'from-b')
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    const result = await brain.chat('q', { provider: 'b' })
    expect(result.text).toBe('from-b')
    expect(a.chatCalls).toHaveLength(0)
    expect(b.chatCalls).toHaveLength(1)
  })

  test('applies defaultCache when options.cache is omitted', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({ default: 'a', providers: { a }, defaultCache: true })
    await brain.chat('q')
    expect(a.chatCalls[0]?.options?.cache).toBe(true)
  })

  test('per-call cache flag overrides defaultCache', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({ default: 'a', providers: { a }, defaultCache: true })
    await brain.chat('q', { cache: false })
    expect(a.chatCalls[0]?.options?.cache).toBe(false)
  })

  test('uses framework tier defaults when no tiers config is passed', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    await brain.chat('q', { tier: 'powerful' })
    expect(a.chatCalls[0]?.options?.model).toBe('claude-opus-4-7')
  })
})

// ─── stream() ────────────────────────────────────────────────────────────

describe('BrainManager — stream()', () => {
  test('forwards events from the configured provider', async () => {
    const a = new StubProvider('a', 'streamed')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    const events: StreamEvent[] = []
    for await (const ev of brain.stream('q')) events.push(ev)
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'text', delta: 'streamed' })
    expect(events[1]?.type).toBe('stop')
  })

  test('respects options.provider when routing the stream', async () => {
    const a = new StubProvider('a')
    const b = new StubProvider('b')
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    for await (const _ of brain.stream('q', { provider: 'b' })) {
      // drain
    }
    expect(a.streamCalls).toHaveLength(0)
    expect(b.streamCalls).toHaveLength(1)
  })
})

// ─── countTokens() ───────────────────────────────────────────────────────

describe('BrainManager — countTokens()', () => {
  test('delegates to the provider when supported', async () => {
    const a = new StubProvider('a')
    a.countTokensImpl = async () => 42
    const brain = new BrainManager({ default: 'a', providers: { a } })
    expect(await brain.countTokens('hello')).toBe(42)
  })

  test('returns null when the provider lacks a countTokens method', async () => {
    const brain = new BrainManager({
      default: 'nc',
      providers: { nc: new StubWithoutCount() },
    })
    expect(await brain.countTokens('hello')).toBeNull()
  })
})

// ─── extend() ────────────────────────────────────────────────────────────

describe('BrainManager — extend()', () => {
  test('registers a post-construction provider that routing can resolve', async () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    const custom = new StubProvider('custom')
    brain.extend('custom', custom)
    await brain.chat('q', { provider: 'custom' })
    expect(custom.chatCalls).toHaveLength(1)
  })

  test('overwrites any existing provider under the same name', async () => {
    const a = new StubProvider('a')
    const b = new StubProvider('b')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    brain.extend('a', b)
    await brain.chat('q')
    expect(a.chatCalls).toHaveLength(0)
    expect(b.chatCalls).toHaveLength(1)
  })

  test('throws on empty name', () => {
    const a = new StubProvider('a')
    const brain = new BrainManager({ default: 'a', providers: { a } })
    expect(() => brain.extend('', a)).toThrow(/non-empty string/)
  })
})
