/**
 * Suspend / resume (human-in-the-loop) tests for the non-streaming
 * `runWithTools` path. Covers all four providers that own their own
 * tool loop:
 *
 *   - AnthropicBrainDriver
 *   - OpenAIBrainDriver (chat completions)
 *   - OpenAIResponsesBrainDriver
 *   - GeminiBrainDriver
 *
 * Also covers the manager-level `resumeTools` helper and the
 * AgentRunner `.suspend(...)` / `.resume(...)` chain. Streaming +
 * schema entrypoints throw on `shouldSuspend` — verified at the
 * BrainManager level.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { Agent } from '../src/agent.ts'
import { BrainManager } from '../src/brain_manager.ts'
import { BrainError } from '../src/brain_error.ts'
import { defineTool } from '../src/define_tool.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import { GeminiBrainDriver } from '../src/drivers/gemini/gemini_brain_driver.ts'
import { OpenAIBrainDriver } from '../src/drivers/openai/openai_brain_driver.ts'
import { OpenAIResponsesBrainDriver } from '../src/drivers/openai_responses/openai_responses_brain_driver.ts'
import { isSuspended, type SuspendedRun } from '../src/suspended_run.ts'
import type { Message, ToolUseBlock } from '../src/types.ts'

// ─── Anthropic suspension ────────────────────────────────────────────────

describe('AnthropicBrainDriver — shouldSuspend', () => {
  function makeFakeClient(responses: Anthropic.Message[]) {
    const calls: Array<{ params: Anthropic.MessageCreateParams }> = []
    const queue = [...responses]
    return {
      client: {
        messages: {
          create: async (params: Anthropic.MessageCreateParams) => {
            calls.push({ params })
            const next = queue.shift()
            if (!next) throw new Error('test: no canned responses left')
            return next
          },
        },
      } as unknown as Anthropic,
      calls,
    }
  }

  function toolUseMessage(id: string, name: string, input: Record<string, unknown>): Anthropic.Message {
    return {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
    } as unknown as Anthropic.Message
  }

  function textMessage(text: string): Anthropic.Message {
    return {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
    } as unknown as Anthropic.Message
  }

  const dropDb = defineTool({
    name: 'drop_db',
    description: 'destructive',
    inputSchema: { type: 'object' },
    execute: async () => 'dropped',
  })

  test('suspends when gate returns true; tool is NOT executed', async () => {
    let executed = false
    const tool = defineTool({
      ...dropDb,
      execute: async () => {
        executed = true
        return 'dropped'
      },
    })
    const { client } = makeFakeClient([
      toolUseMessage('tu_1', 'drop_db', { name: 'users' }),
    ])
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const out = await provider.runWithTools(
      [{ role: 'user', content: 'drop users' }],
      [tool],
      { shouldSuspend: () => true },
    )
    expect(isSuspended(out)).toBe(true)
    if (!isSuspended(out)) throw new Error('unreachable')
    expect(out.pendingToolCalls).toHaveLength(1)
    expect(out.pendingToolCalls[0]?.id).toBe('tu_1')
    expect(out.pendingToolCalls[0]?.name).toBe('drop_db')
    expect(executed).toBe(false)
  })

  test('mid-batch suspension captures the triggering call + all later siblings', async () => {
    const safe = defineTool({ ...dropDb, name: 'safe', execute: async () => 'ok' })
    // Anthropic emits multiple tool_use blocks in a single assistant
    // turn — simulate that by constructing the response manually.
    const message = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [
        { type: 'tool_use', id: 'a', name: 'safe', input: {} },
        { type: 'tool_use', id: 'b', name: 'drop_db', input: {} },
        { type: 'tool_use', id: 'c', name: 'safe', input: {} },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
    } as unknown as Anthropic.Message
    const { client } = makeFakeClient([message])
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const out = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [safe, dropDb],
      { shouldSuspend: (call) => call.name === 'drop_db' },
    )
    if (!isSuspended(out)) throw new Error('expected suspension')
    // The "drop_db" trigger + the subsequent safe call must both
    // be captured — the provider's tool_use/tool_result pairing
    // would otherwise be unbalanced on resume.
    expect(out.pendingToolCalls.map((c) => c.id)).toEqual(['b', 'c'])
  })

  test('resume completes the loop when results are supplied for every pending call', async () => {
    const { client } = makeFakeClient([
      toolUseMessage('tu_1', 'drop_db', {}),
      textMessage('done'),
    ])
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const brain = new BrainManager({
      default: 'anthropic',
      providers: { anthropic: provider },
    })
    const out = await brain.runTools('drop users', [dropDb], {
      shouldSuspend: () => true,
    })
    if (!isSuspended(out)) throw new Error('expected suspension')

    const resumed = await brain.resumeTools(
      out.state,
      [{ toolUseId: 'tu_1', content: 'approved by liva' }],
      [dropDb],
    )
    if (isSuspended(resumed)) throw new Error('unexpected re-suspension')
    expect(resumed.text).toBe('done')
    expect(resumed.iterations).toBe(1)
  })

  test('resume throws BrainError when a pending result is missing', async () => {
    const state: SuspendedRun['state'] = {
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'drop_db', input: {} } satisfies ToolUseBlock,
            { type: 'tool_use', id: 'b', name: 'drop_db', input: {} } satisfies ToolUseBlock,
          ],
        },
      ] as Message[],
      iterations: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }
    const { client } = makeFakeClient([])
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk-test' },
      { client },
    )
    const brain = new BrainManager({ default: 'anthropic', providers: { anthropic: provider } })
    await expect(
      brain.resumeTools(state, [{ toolUseId: 'a', content: 'r' }], [dropDb]),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

// ─── OpenAI chat-completions suspension ─────────────────────────────────

describe('OpenAIBrainDriver — shouldSuspend', () => {
  function fakeCompletion(opts: {
    toolCalls?: Array<{ id: string; name: string; args: string }>
    text?: string
    finish: 'tool_calls' | 'stop'
  }): OpenAI.Chat.ChatCompletion {
    return {
      id: 'c',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          finish_reason: opts.finish,
          message: {
            role: 'assistant',
            content: opts.text ?? null,
            tool_calls: (opts.toolCalls ?? []).map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.args },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as unknown as OpenAI.Chat.ChatCompletion
  }

  test('suspends mid-batch and includes remaining siblings', async () => {
    const tool = defineTool({
      name: 'destructive',
      description: 'x',
      inputSchema: { type: 'object' },
      execute: async () => 'ran',
    })
    const safe = defineTool({
      name: 'safe',
      description: 'x',
      inputSchema: { type: 'object' },
      execute: async () => 'ran',
    })
    const client = {
      chat: {
        completions: {
          create: async () =>
            fakeCompletion({
              toolCalls: [
                { id: 'a', name: 'safe', args: '{}' },
                { id: 'b', name: 'destructive', args: '{"x":1}' },
                { id: 'c', name: 'safe', args: '{}' },
              ],
              finish: 'tool_calls',
            }),
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk' },
      { client },
    )
    const out = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool, safe],
      { shouldSuspend: (call) => call.name === 'destructive' },
    )
    if (!isSuspended(out)) throw new Error('expected suspension')
    expect(out.pendingToolCalls.map((c) => c.id)).toEqual(['b', 'c'])
    expect(out.pendingToolCalls[0]?.input).toEqual({ x: 1 })
  })
})

// ─── OpenAIResponses suspension + previousResponseId ────────────────────

describe('OpenAIResponsesBrainDriver — shouldSuspend + previousResponseId', () => {
  function fakeResponse(opts: {
    text?: string
    toolCalls?: Array<{ callId: string; name: string; args: string }>
    id?: string
    status?: string
  }) {
    const output: OpenAI.Responses.ResponseOutputItem[] = []
    if (opts.text) {
      output.push({
        type: 'message',
        id: 'msg',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: opts.text, annotations: [], logprobs: [] }],
      } as unknown as OpenAI.Responses.ResponseOutputItem)
    }
    for (const c of opts.toolCalls ?? []) {
      output.push({
        type: 'function_call',
        id: `fc_${c.callId}`,
        call_id: c.callId,
        name: c.name,
        arguments: c.args,
        status: 'completed',
      } as unknown as OpenAI.Responses.ResponseOutputItem)
    }
    return {
      id: opts.id ?? 'resp_1',
      output,
      status: opts.status ?? 'completed',
      model: 'gpt-5',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }
  }

  test('suspends and captures responseId on the state for stateful resume', async () => {
    const tool = defineTool({
      name: 'do_x',
      description: 'x',
      inputSchema: { type: 'object' },
      execute: async () => 'x',
    })
    const client = {
      responses: {
        create: async () =>
          fakeResponse({ id: 'resp_abc', toolCalls: [{ callId: 'fc_1', name: 'do_x', args: '{}' }] }),
      },
    } as unknown as OpenAI
    const provider = new OpenAIResponsesBrainDriver(
      'openai-responses',
      { driver: 'openai-responses', apiKey: 'sk' },
      { client },
    )
    const out = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { shouldSuspend: () => true },
    )
    if (!isSuspended(out)) throw new Error('expected suspension')
    expect(out.state.responseId).toBe('resp_abc')
  })

  test('chat() emits previous_response_id and surfaces responseId on the result', async () => {
    const calls: Array<{ params: OpenAI.Responses.ResponseCreateParams }> = []
    const client = {
      responses: {
        create: async (params: OpenAI.Responses.ResponseCreateParams) => {
          calls.push({ params })
          return fakeResponse({ id: 'resp_new', text: 'hi' })
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIResponsesBrainDriver(
      'openai-responses',
      { driver: 'openai-responses', apiKey: 'sk' },
      { client },
    )
    const result = await provider.chat(
      [{ role: 'user', content: 'q' }],
      { previousResponseId: 'resp_prev' },
    )
    expect(result.responseId).toBe('resp_new')
    expect((calls[0]?.params as { previous_response_id?: string }).previous_response_id).toBe(
      'resp_prev',
    )
  })

  test('Thread auto-threads lastResponseId across sends and persists across fromJSON', async () => {
    const calls: Array<{ params: OpenAI.Responses.ResponseCreateParams }> = []
    const responses = [
      fakeResponse({ id: 'resp_1', text: 'first' }),
      fakeResponse({ id: 'resp_2', text: 'second' }),
      fakeResponse({ id: 'resp_3', text: 'third' }),
    ]
    let i = 0
    const client = {
      responses: {
        create: async (params: OpenAI.Responses.ResponseCreateParams) => {
          calls.push({ params })
          return responses[i++]!
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAIResponsesBrainDriver(
      'openai-responses',
      { driver: 'openai-responses', apiKey: 'sk' },
      { client },
    )
    const brain = new BrainManager({
      default: 'openai-responses',
      providers: { 'openai-responses': provider },
    })
    const { Thread } = await import('../src/thread.ts')
    const t = new Thread(brain)
    await t.send('first')
    expect(t.lastResponseId).toBe('resp_1')
    await t.send('second')
    expect((calls[1]?.params as { previous_response_id?: string }).previous_response_id).toBe(
      'resp_1',
    )
    // Round-trip through JSON.
    const snapshot = t.toJSON()
    expect(snapshot.lastResponseId).toBe('resp_2')
    const restored = Thread.fromJSON(brain, snapshot)
    await restored.send('third')
    expect((calls[2]?.params as { previous_response_id?: string }).previous_response_id).toBe(
      'resp_2',
    )
  })
})

// ─── Gemini suspension ──────────────────────────────────────────────────

describe('GeminiBrainDriver — shouldSuspend', () => {
  test('suspends before executing the gated tool', async () => {
    const tool = defineTool({
      name: 'gemini_tool',
      description: 'x',
      inputSchema: { type: 'object' },
      execute: async () => 'x',
    })
    // Stub: candidates with a functionCall part.
    const fakeResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'gemini_tool', args: { q: 1 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
    }
    const provider = new GeminiBrainDriver(
      'gemini',
      { driver: 'google', apiKey: 'k' },
    )
    // Swap the SDK seam — the provider stores `models`.
    ;(provider as unknown as {
      models: { generateContent: (p: unknown) => Promise<unknown> }
    }).models = {
      generateContent: async () => fakeResponse,
    }
    const out = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { shouldSuspend: () => true },
    )
    if (!isSuspended(out)) throw new Error('expected suspension')
    expect(out.pendingToolCalls).toHaveLength(1)
    expect(out.pendingToolCalls[0]?.name).toBe('gemini_tool')
  })
})

// ─── BrainManager guards + AgentRunner integration ──────────────────────

describe('BrainManager — shouldSuspend rejected on streaming + schema', () => {
  function brainWithStub() {
    return new BrainManager({
      default: 'anthropic',
      providers: {
        anthropic: new AnthropicBrainDriver(
          'anthropic',
          { driver: 'anthropic', apiKey: 'sk' },
        ),
      },
    })
  }

  test('generateWithTools throws BrainError when shouldSuspend is set', async () => {
    const brain = brainWithStub()
    await expect(
      brain.generateWithTools(
        'q',
        { name: 's', jsonSchema: { type: 'object' } },
        [],
        { shouldSuspend: () => true },
      ),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('streamTools throws BrainError when shouldSuspend is set', () => {
    const brain = brainWithStub()
    expect(() =>
      brain.streamTools('q', [], { shouldSuspend: () => true }),
    ).toThrow(BrainError)
  })

  test('streamGenerateWithTools throws BrainError when shouldSuspend is set', () => {
    const brain = brainWithStub()
    expect(() =>
      brain.streamGenerateWithTools(
        'q',
        { name: 's', jsonSchema: { type: 'object' } },
        [],
        { shouldSuspend: () => true },
      ),
    ).toThrow(BrainError)
  })
})

describe('AgentRunner.suspend / .resume', () => {
  class TestAgent extends Agent {
    override readonly instructions = 'be helpful'
    override readonly tools = [
      defineTool({
        name: 'destructive',
        description: 'x',
        inputSchema: { type: 'object' },
        execute: async () => 'ran',
      }),
    ]
  }

  function fakeAnthropic(responses: Anthropic.Message[]) {
    const queue = [...responses]
    return {
      messages: {
        create: async () => {
          const next = queue.shift()
          if (!next) throw new Error('test: no canned responses')
          return next
        },
      },
    } as unknown as Anthropic
  }

  test('full suspend → resume round-trip via AgentRunner', async () => {
    const provider = new AnthropicBrainDriver(
      'anthropic',
      { driver: 'anthropic', apiKey: 'sk' },
      {
        client: fakeAnthropic([
          {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [{ type: 'tool_use', id: 'tu', name: 'destructive', input: {} }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          } as unknown as Anthropic.Message,
          {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [{ type: 'text', text: 'all good', citations: null }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
          } as unknown as Anthropic.Message,
        ]),
      },
    )
    const brain = new BrainManager({
      default: 'anthropic',
      providers: { anthropic: provider },
    })
    const runner = brain
      .agent(TestAgent)
      .input('do the thing')
      .suspend(() => true)
    const out = await runner.run()
    if (!isSuspended(out)) throw new Error('expected suspension')
    const resumed = await runner.resume(out.state, [
      { toolUseId: 'tu', content: 'approved' },
    ])
    if (isSuspended(resumed)) throw new Error('unexpected re-suspension')
    expect(resumed.text).toBe('all good')
  })
})
