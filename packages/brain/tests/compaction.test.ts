/**
 * Compaction tests — `compact-2026-01-12` beta on `AnthropicBrainDriver`,
 * plus the framework-level surface (`ChatOptions.compact`,
 * `ChatResult.content`, `CompactionBlock` round-trip, Thread
 * preservation).
 *
 * Stubs both the plain and beta SDK surfaces so each test can assert
 * which path the provider routed through.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { BrainManager } from '../src/brain_manager.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { Thread } from '../src/thread.ts'
import type { CompactionBlock, Message } from '../src/types.ts'

interface CapturedCall {
  surface: 'plain' | 'beta'
  params: Anthropic.MessageCreateParamsNonStreaming & {
    edits?: unknown[]
    betas?: readonly string[]
  }
}

function makeMessage(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

function makeClient(responses: Anthropic.Message[]) {
  const calls: CapturedCall[] = []
  const queue = [...responses]
  const handle = (surface: 'plain' | 'beta') =>
    async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      calls.push({ surface, params: params as CapturedCall['params'] })
      const next = queue.shift()
      if (!next) throw new Error('test: out of canned responses')
      return next
    }
  const client = {
    messages: { create: handle('plain') },
    beta: { messages: { create: handle('beta') } },
  } as unknown as Anthropic
  return { client, calls }
}

function makeProvider(client: Anthropic) {
  return new AnthropicBrainDriver(
    'anthropic',
    { driver: 'anthropic', apiKey: 'sk-test', defaultModel: 'claude-opus-4-7' },
    { client },
  )
}

// ─── buildParams emits edits + beta header ──────────────────────────────

describe('AnthropicBrainDriver — outbound compaction request', () => {
  test('options.compact with all fields emits the right edits entry + flips beta routing', async () => {
    const { client, calls } = makeClient([makeMessage([
      { type: 'text', text: 'ok', citations: null } as unknown as Anthropic.ContentBlock,
    ])])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      compact: {
        trigger: 80_000,
        instructions: 'keep customer ids',
        pauseAfterCompaction: true,
      },
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.surface).toBe('beta')
    expect(call.params.edits).toEqual([
      {
        type: 'compact_20260112',
        trigger: { type: 'input_tokens', value: 80_000 },
        instructions: 'keep customer ids',
        pause_after_compaction: true,
      },
    ])
    expect(call.params.betas).toEqual(['compact-2026-01-12'])
  })

  test('options.compact = {} (defaults) still emits edits entry + beta routing', async () => {
    const { client, calls } = makeClient([makeMessage([
      { type: 'text', text: 'ok', citations: null } as unknown as Anthropic.ContentBlock,
    ])])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { compact: {} })
    expect(calls[0]?.surface).toBe('beta')
    expect(calls[0]?.params.edits).toEqual([{ type: 'compact_20260112' }])
  })

  test('omitting compact uses the plain (non-beta) surface', async () => {
    const { client, calls } = makeClient([makeMessage([
      { type: 'text', text: 'ok', citations: null } as unknown as Anthropic.ContentBlock,
    ])])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(calls[0]?.surface).toBe('plain')
    expect(calls[0]?.params.edits).toBeUndefined()
    expect(calls[0]?.params.betas).toBeUndefined()
  })
})

// ─── inbound compaction block surfaces on result.content ────────────────

describe('AnthropicBrainDriver — inbound compaction block', () => {
  test('compaction block on the assistant turn shows up on result.content', async () => {
    const { client } = makeClient([
      makeMessage([
        {
          type: 'compaction',
          content: 'older turns summarized',
          encrypted_content: 'opaque-blob',
        } as unknown as Anthropic.ContentBlock,
        { type: 'text', text: 'and here is the answer', citations: null } as unknown as Anthropic.ContentBlock,
      ]),
    ])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }], { compact: {} })

    expect(result.text).toBe('and here is the answer')
    expect(result.content).toBeDefined()
    expect(result.content).toHaveLength(2)
    expect(result.content?.[0]).toEqual({
      type: 'compaction',
      content: 'older turns summarized',
      encryptedContent: 'opaque-blob',
    } satisfies CompactionBlock)
  })

  test('failed compaction (content === null) round-trips with the null preserved', async () => {
    const { client } = makeClient([
      makeMessage([
        { type: 'compaction', content: null, encrypted_content: null } as unknown as Anthropic.ContentBlock,
        { type: 'text', text: 'ok', citations: null } as unknown as Anthropic.ContentBlock,
      ]),
    ])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }], { compact: {} })
    const block = result.content?.[0] as CompactionBlock
    expect(block.type).toBe('compaction')
    expect(block.content).toBeNull()
    expect(block.encryptedContent).toBeNull()
  })

  test('plain text response leaves result.content undefined', async () => {
    const { client } = makeClient([makeMessage([
      { type: 'text', text: 'hi', citations: null } as unknown as Anthropic.ContentBlock,
    ])])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.content).toBeUndefined()
  })
})

// ─── outbound CompactionBlock round-trip ─────────────────────────────────

describe('AnthropicBrainDriver — CompactionBlock round-trip on subsequent send', () => {
  test('a Message carrying CompactionBlock translates back to a compaction param', async () => {
    const { client, calls } = makeClient([makeMessage([
      { type: 'text', text: 'thanks', citations: null } as unknown as Anthropic.ContentBlock,
    ])])
    const provider = makeProvider(client)
    const messages: Message[] = [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: [
          {
            type: 'compaction',
            content: 'older turns summarized',
            encryptedContent: 'opaque-blob',
          },
          { type: 'text', text: 'and answer' },
        ],
      },
      { role: 'user', content: 'next' },
    ]
    await provider.chat(messages, { compact: {} })
    const sent = calls[0]?.params.messages as Array<Anthropic.MessageParam>
    const assistant = sent[1]
    expect(assistant?.role).toBe('assistant')
    const blocks = assistant?.content as unknown as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({
      type: 'compaction',
      content: 'older turns summarized',
      encrypted_content: 'opaque-blob',
    })
    expect(blocks[1]).toEqual({ type: 'text', text: 'and answer' })
  })
})

// ─── Thread preserves compaction blocks across sends ─────────────────────

describe('Thread — preserves compaction blocks across sends', () => {
  test('a turn that emits a compaction block ends up on thread.messages as structured content', async () => {
    const { client, calls } = makeClient([
      makeMessage([
        {
          type: 'compaction',
          content: 'summary so far',
          encrypted_content: 'blob-1',
        } as unknown as Anthropic.ContentBlock,
        { type: 'text', text: 'first reply', citations: null } as unknown as Anthropic.ContentBlock,
      ]),
      makeMessage([
        { type: 'text', text: 'second reply', citations: null } as unknown as Anthropic.ContentBlock,
      ]),
    ])
    const provider = makeProvider(client)
    const brain = new BrainManager({
      default: 'anthropic',
      providers: { anthropic: provider },
    })
    const t = new Thread(brain, { options: { compact: {} } })

    const reply1 = await t.send('first')
    expect(reply1).toBe('first reply')

    // Assistant turn must be structured (compaction + text) — not the
    // plain `result.text` string.
    const assistant1 = t.messages[1]
    expect(Array.isArray(assistant1?.content)).toBe(true)
    const blocks = assistant1?.content as Array<{ type: string }>
    expect(blocks.map((b) => b.type)).toEqual(['compaction', 'text'])

    // Second send echoes the prior compaction block back to the
    // server — that's the whole point: older turns drop out, only
    // the summary survives.
    await t.send('second')
    const secondParams = calls[1]?.params.messages as Array<Anthropic.MessageParam>
    const assistantSent = secondParams[1]?.content as Array<{ type: string }>
    expect(assistantSent[0]?.type).toBe('compaction')
  })

  test('toJSON / fromJSON preserves structured compaction content', async () => {
    const { client } = makeClient([
      makeMessage([
        {
          type: 'compaction',
          content: 'summary',
          encrypted_content: 'blob',
        } as unknown as Anthropic.ContentBlock,
        { type: 'text', text: 'reply', citations: null } as unknown as Anthropic.ContentBlock,
      ]),
    ])
    const provider = makeProvider(client)
    const brain = new BrainManager({
      default: 'anthropic',
      providers: { anthropic: provider },
    })
    const t = new Thread(brain, { options: { compact: {} } })
    await t.send('q')

    const snapshot = t.toJSON()
    const restored = Thread.fromJSON(brain, snapshot)
    const assistant = restored.messages[1]
    const blocks = assistant?.content as Array<{ type: string }>
    expect(blocks.map((b) => b.type)).toEqual(['compaction', 'text'])
  })
})
