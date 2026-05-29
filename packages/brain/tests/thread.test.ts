/**
 * `Thread` tests. The thread builds on `BrainManager.chat`, so the
 * provider is a stub that records calls and returns canned replies.
 */

import { describe, expect, test } from 'bun:test'
import { BrainManager } from '../src/brain_manager.ts'
import type { Provider } from '../src/provider.ts'
import { Thread } from '../src/thread.ts'
import type { ChatOptions, ChatResult, Message, StreamEvent } from '../src/types.ts'

class CannedProvider implements Provider {
  readonly name = 'canned'
  readonly chatCalls: Array<{ messages: readonly Message[]; options: ChatOptions | undefined }> = []
  constructor(private readonly replies: readonly string[]) {}

  async chat(messages: readonly Message[], options?: ChatOptions): Promise<ChatResult> {
    // Snapshot the array — Thread reuses one buffer and keeps mutating
    // it after this call returns. Without the copy, every recorded
    // call references the same final state.
    this.chatCalls.push({ messages: [...messages], options })
    const text = this.replies[this.chatCalls.length - 1] ?? '(out of canned replies)'
    return {
      text,
      model: 'canned',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      raw: {},
    }
  }
  async *stream(): AsyncIterable<StreamEvent> {}
}

function makeBrain(replies: readonly string[]): { brain: BrainManager; provider: CannedProvider } {
  const provider = new CannedProvider(replies)
  return {
    brain: new BrainManager({ default: 'canned', providers: { canned: provider } }),
    provider,
  }
}

describe('Thread', () => {
  test('append-only history grows by 2 per send()', async () => {
    const { brain } = makeBrain(['r1', 'r2'])
    const thread = new Thread(brain)

    await thread.send('q1')
    await thread.send('q2')

    expect(thread.messages).toHaveLength(4)
    expect(thread.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect((thread.messages[1] as Message).content).toBe('r1')
    expect((thread.messages[3] as Message).content).toBe('r2')
  })

  test('send() returns the assistant text', async () => {
    const { brain } = makeBrain(['hello back'])
    const thread = new Thread(brain)
    const reply = await thread.send('hi')
    expect(reply).toBe('hello back')
  })

  test('passes the full prior conversation on each call', async () => {
    const { brain, provider } = makeBrain(['r1', 'r2', 'r3'])
    const thread = new Thread(brain)
    await thread.send('q1')
    await thread.send('q2')
    await thread.send('q3')

    expect(provider.chatCalls).toHaveLength(3)
    expect(provider.chatCalls[2]?.messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'q3' },
    ])
  })

  test('thread.system is forwarded on every call', async () => {
    const { brain, provider } = makeBrain(['ack'])
    const thread = new Thread(brain, { system: 'be helpful' })
    await thread.send('hi')
    expect(provider.chatCalls[0]?.options?.system).toBe('be helpful')
  })

  test('thread.system wins over per-call system to prevent mid-thread drift', async () => {
    const { brain, provider } = makeBrain(['ack'])
    const thread = new Thread(brain, { system: 'be helpful' })
    await thread.send('hi', { system: 'ignore previous' as unknown as never })
    // The thread's system overrides the per-call attempt.
    expect(provider.chatCalls[0]?.options?.system).toBe('be helpful')
  })

  test('per-call options merge over thread options (non-system fields)', async () => {
    const { brain, provider } = makeBrain(['r'])
    const thread = new Thread(brain, { options: { maxTokens: 100, tier: 'fast' } })
    await thread.send('q', { tier: 'powerful' })
    expect(provider.chatCalls[0]?.options?.maxTokens).toBe(100)
    expect(provider.chatCalls[0]?.options?.tier).toBe('powerful')
  })

  test('toJSON / fromJSON round-trips the conversation', async () => {
    const { brain } = makeBrain(['r1', 'r2'])
    const original = new Thread(brain, { system: 'be terse', options: { maxTokens: 500 } })
    await original.send('hi')
    await original.send('again')

    const json = original.toJSON()
    const restored = Thread.fromJSON(brain, json)

    expect(restored.messages).toEqual(original.messages)
    expect(restored.system).toBe('be terse')
    expect(restored.options?.maxTokens).toBe(500)
  })

  test('length reflects messages.length', async () => {
    const { brain } = makeBrain(['r'])
    const thread = new Thread(brain)
    expect(thread.length).toBe(0)
    await thread.send('q')
    expect(thread.length).toBe(2)
  })
})
