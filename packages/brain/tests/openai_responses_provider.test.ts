/**
 * `OpenAIResponsesProvider` tests — covers the divergences from
 * `OpenAIProvider` (which uses chat completions):
 *
 *   - Uses `client.responses.create` not
 *     `client.chat.completions.create`.
 *   - Different request shape: `input` + `instructions` +
 *     `max_output_tokens` instead of `messages` + system msg +
 *     `max_completion_tokens`.
 *   - Different response shape: `output[]` items not `choices[]`.
 *   - Server tools translate to Responses API types
 *     (`web_search`, `code_interpreter`) — not the chat
 *     completions tools format.
 *   - Schema variants throw with "deferred" guidance.
 *
 * Stubs the SDK client; no network calls.
 */

import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'
import { BrainError } from '../src/brain_error.ts'
import { defineTool } from '../src/define_tool.ts'
import { OpenAIResponsesProvider } from '../src/providers/openai_responses_provider.ts'

// ─── Fake SDK client ────────────────────────────────────────────────────

interface ResponseStub {
  /** Output array — text + tool calls. */
  output: OpenAI.Responses.ResponseOutputItem[]
  status?: string
  model?: string
  usage?: OpenAI.Responses.ResponseUsage
}

function makeResponse(opts: {
  text?: string
  toolCalls?: Array<{ callId: string; name: string; arguments: string }>
  status?: string
  model?: string
  usage?: OpenAI.Responses.ResponseUsage
}): ResponseStub {
  const output: OpenAI.Responses.ResponseOutputItem[] = []
  if (opts.text) {
    output.push({
      type: 'message',
      id: 'msg_1',
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
      arguments: c.arguments,
      status: 'completed',
    } as unknown as OpenAI.Responses.ResponseOutputItem)
  }
  return {
    output,
    status: opts.status ?? 'completed',
    model: opts.model ?? 'gpt-5',
    usage: opts.usage ?? {
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    } as OpenAI.Responses.ResponseUsage,
  }
}

function makeFakeClient(responses: ResponseStub[]) {
  const calls: Array<{ params: OpenAI.Responses.ResponseCreateParams }> = []
  const queue = [...responses]
  const client = {
    responses: {
      create: async (params: OpenAI.Responses.ResponseCreateParams) => {
        calls.push({ params })
        if ((params as { stream?: boolean }).stream === true) {
          // For streaming tests we never need to hit this path — they
          // build their own stream stubs.
          throw new Error('test: streaming requested but no stream stub provided')
        }
        const next = queue.shift()
        if (!next) throw new Error('test: no canned responses left')
        return next as unknown as OpenAI.Responses.Response
      },
    },
  } as unknown as OpenAI
  return { client, calls }
}

function makeProvider(client: OpenAI) {
  return new OpenAIResponsesProvider(
    'openai-responses',
    { driver: 'openai-responses', apiKey: 'sk-test' },
    { client },
  )
}

// ─── chat — basic translation ───────────────────────────────────────────

describe('OpenAIResponsesProvider.chat()', () => {
  test('plain prompt translates to input + instructions; result.text from output_text', async () => {
    const { client, calls } = makeFakeClient([makeResponse({ text: 'hello back' })])
    const provider = makeProvider(client)
    const result = await provider.chat(
      [{ role: 'user', content: 'hello' }],
      { system: 'be concise' },
    )

    expect(result.text).toBe('hello back')
    expect(result.model).toBe('gpt-5')
    const params = calls[0]?.params
    expect(params?.instructions).toBe('be concise')
    expect(params?.model).toBe('gpt-5')
    expect(params?.max_output_tokens).toBe(4096)
    expect(params?.input).toEqual([{ role: 'user', content: 'hello' }])
  })

  test('reasoning effort → reasoning.effort', async () => {
    const { client, calls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { effort: 'high' })
    expect(calls[0]?.params.reasoning).toEqual({ effort: 'high' })
  })

  test('usage maps input_tokens / output_tokens / cached_tokens', async () => {
    const { client } = makeFakeClient([
      makeResponse({
        text: 'ok',
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          total_tokens: 19,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 0 },
        } as OpenAI.Responses.ResponseUsage,
      }),
    ])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
    })
  })
})

// ─── runWithTools — function calling loop ───────────────────────────────

describe('OpenAIResponsesProvider.runWithTools()', () => {
  test('tools translate to type:"function" with name/description/parameters', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echoes input',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async (i: { x: string }) => i.x,
    })
    const { client, calls } = makeFakeClient([
      makeResponse({ text: 'no tools used', status: 'completed' }),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])

    const tools = calls[0]?.params.tools as Array<{ type: string; name?: string; description?: string; parameters?: unknown; strict?: boolean }>
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'echo',
        description: 'echoes input',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
        strict: false,
      },
    ])
  })

  test('executes a function_call → feeds function_call_output back → completes', async () => {
    const tool = defineTool({
      name: 'add',
      description: 'adds',
      inputSchema: { type: 'object' },
      execute: async (i: { a: number; b: number }) => i.a + i.b,
    })
    const { client, calls } = makeFakeClient([
      makeResponse({
        toolCalls: [{ callId: 'call_1', name: 'add', arguments: '{"a":2,"b":3}' }],
        status: 'completed',
      }),
      makeResponse({ text: '5', status: 'completed' }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools([{ role: 'user', content: '2+3' }], [tool])

    expect(result.text).toBe('5')
    expect(result.iterations).toBe(1)
    // Second call's input should include a function_call_output item.
    const secondInput = calls[1]?.params.input as Array<{ type?: string; call_id?: string; output?: string }>
    const fnOutput = secondInput.find((i) => i.type === 'function_call_output')
    expect(fnOutput).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '5',
    })
  })

  test('combines server tools (web_search) with framework tools', async () => {
    const tool = defineTool({
      name: 'local',
      description: 'local',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    })
    const { client, calls } = makeFakeClient([
      makeResponse({ text: 'searched', status: 'completed' }),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { serverTools: [{ type: 'web_search' }, { type: 'code_execution' }] },
    )
    const tools = calls[0]?.params.tools as Array<{ type: string }>
    expect(tools.map((t) => t.type)).toEqual([
      'function',
      'web_search',
      'code_interpreter',
    ])
  })

  test('serverTools web_fetch → throws BrainError', async () => {
    const { client } = makeFakeClient([])
    const provider = makeProvider(client)
    await expect(
      provider.chat([{ role: 'user', content: 'q' }], {
        serverTools: [{ type: 'web_fetch' }],
      }),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('serverTools url_context → throws BrainError', async () => {
    const { client } = makeFakeClient([])
    const provider = makeProvider(client)
    await expect(
      provider.chat([{ role: 'user', content: 'q' }], {
        serverTools: [{ type: 'url_context' }],
      }),
    ).rejects.toBeInstanceOf(BrainError)
  })
})

// ─── Schema variants throw — deferred ──────────────────────────────────

describe('OpenAIResponsesProvider — schema variants throw', () => {
  test('generate throws with "follow-up slice" guidance', async () => {
    const { client } = makeFakeClient([])
    const provider = makeProvider(client)
    await expect(
      provider.generate(
        [{ role: 'user', content: 'q' }],
        { name: 's', jsonSchema: { type: 'object' } },
      ),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('runWithToolsAndSchema throws', async () => {
    const { client } = makeFakeClient([])
    const provider = makeProvider(client)
    await expect(
      provider.runWithToolsAndSchema(
        [{ role: 'user', content: 'q' }],
        [],
        { name: 's', jsonSchema: { type: 'object' } },
      ),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('streamWithToolsAndSchema throws on first iteration', async () => {
    const { client } = makeFakeClient([])
    const provider = makeProvider(client)
    let thrown: unknown
    try {
      for await (const _e of provider.streamWithToolsAndSchema(
        [{ role: 'user', content: 'q' }],
        [],
        { name: 's', jsonSchema: { type: 'object' } },
      )) {
        // drain
      }
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
  })
})

// ─── stream() — text deltas + terminal stop ──────────────────────────────

describe('OpenAIResponsesProvider.stream()', () => {
  test('emits text deltas then a terminal stop event', async () => {
    const streamEvents = [
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]
    const client = {
      responses: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const e of streamEvents) yield e
          },
        }),
      },
    } as unknown as OpenAI
    const provider = makeProvider(client)
    const events: Array<{ type: string; delta?: string }> = []
    for await (const e of provider.stream([{ role: 'user', content: 'q' }])) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'stop'])
    expect(events[0]?.delta).toBe('hel')
    expect(events[1]?.delta).toBe('lo')
  })
})
