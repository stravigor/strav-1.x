/**
 * `OpenAIResponsesBrainDriver` tests — covers the divergences from
 * `OpenAIBrainDriver` (which uses chat completions):
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
 *   - Structured output via `text.format: { type: 'json_schema' }`:
 *     `generate`, `runWithToolsAndSchema`, `streamWithToolsAndSchema`.
 *
 * Stubs the SDK client; no network calls.
 */

import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'
import { BrainError } from "../../../src/brain_error.ts"
import { defineTool } from "../../../src/define_tool.ts"
import { OpenAIResponsesBrainDriver } from "../../../src/drivers/openai_responses/openai_responses_brain_driver.ts"

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
  return new OpenAIResponsesBrainDriver(
    'openai-responses',
    { driver: 'openai-responses', apiKey: 'sk-test' },
    { client },
  )
}

// ─── chat — basic translation ───────────────────────────────────────────

describe('OpenAIResponsesBrainDriver.chat()', () => {
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

describe('OpenAIResponsesBrainDriver.runWithTools()', () => {
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

// ─── generate / runWithToolsAndSchema — structured output ──────────────

describe('OpenAIResponsesBrainDriver — structured output', () => {
  const personSchema = {
    name: 'person',
    description: 'a person',
    jsonSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
      additionalProperties: false,
    },
  }

  test('generate emits text.format json_schema and parses the result', async () => {
    const { client, calls } = makeFakeClient([
      makeResponse({ text: '{"name":"Liva","age":33}' }),
    ])
    const provider = makeProvider(client)
    const result = await provider.generate(
      [{ role: 'user', content: 'who?' }],
      personSchema,
    )

    expect(result.value).toEqual({ name: 'Liva', age: 33 })
    expect(result.text).toBe('{"name":"Liva","age":33}')
    const params = calls[0]?.params as { text?: { format?: Record<string, unknown> } }
    expect(params.text?.format).toEqual({
      type: 'json_schema',
      name: 'person',
      schema: personSchema.jsonSchema,
      strict: true,
      description: 'a person',
    })
  })

  test('generate rejects when response is not valid JSON', async () => {
    const { client } = makeFakeClient([makeResponse({ text: 'not json' })])
    const provider = makeProvider(client)
    await expect(
      provider.generate([{ role: 'user', content: 'q' }], personSchema),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('generate runs schema.parse when provided', async () => {
    const schema = {
      ...personSchema,
      parse(v: unknown) {
        const p = v as { name: string; age: number }
        if (p.age < 0) throw new Error('negative age')
        return p
      },
    }
    const { client } = makeFakeClient([
      makeResponse({ text: '{"name":"A","age":-1}' }),
    ])
    const provider = makeProvider(client)
    await expect(
      provider.generate([{ role: 'user', content: 'q' }], schema),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test('runWithToolsAndSchema loops tools, parses final json, sets text.format every call', async () => {
    const tool = defineTool({
      name: 'lookup',
      description: 'looks up',
      inputSchema: { type: 'object' },
      execute: async () => 'Liva, 33',
    })
    const { client, calls } = makeFakeClient([
      makeResponse({
        toolCalls: [{ callId: 'c1', name: 'lookup', arguments: '{}' }],
      }),
      makeResponse({ text: '{"name":"Liva","age":33}' }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithToolsAndSchema(
      [{ role: 'user', content: 'q' }],
      [tool],
      personSchema,
    )

    expect(result.value).toEqual({ name: 'Liva', age: 33 })
    expect(result.text).toBe('{"name":"Liva","age":33}')
    expect(result.iterations).toBe(1)
    // text.format is set on every call in the loop.
    for (const c of calls) {
      const p = c.params as { text?: { format?: { type?: string } } }
      expect(p.text?.format?.type).toBe('json_schema')
    }
  })
})

// ─── streamWithToolsAndSchema — schema + streaming ─────────────────────

describe('OpenAIResponsesBrainDriver.streamWithToolsAndSchema()', () => {
  const personSchema = {
    name: 'person',
    jsonSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  }

  test('emits text deltas then a terminal stop with value + text', async () => {
    const completed = {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: '{"name":"Liva"}', annotations: [], logprobs: [] },
            ],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }
    const streamEvents = [
      { type: 'response.output_text.delta', delta: '{"name":' },
      { type: 'response.output_text.delta', delta: '"Liva"}' },
      completed,
    ]
    const calls: Array<{ params: OpenAI.Responses.ResponseCreateParams }> = []
    const client = {
      responses: {
        create: async (params: OpenAI.Responses.ResponseCreateParams) => {
          calls.push({ params })
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of streamEvents) yield e
            },
          }
        },
      },
    } as unknown as OpenAI
    const provider = makeProvider(client)
    const events: Array<Record<string, unknown>> = []
    for await (const e of provider.streamWithToolsAndSchema(
      [{ role: 'user', content: 'q' }],
      [],
      personSchema,
    )) {
      events.push(e as unknown as Record<string, unknown>)
    }
    expect(events.map((e) => e.type as string)).toEqual([
      'iteration_start',
      'text',
      'text',
      'iteration_end',
      'stop',
    ])
    const stop = events[events.length - 1] as {
      type: 'stop'
      value: { name: string }
      text: string
      stopReason: string
    }
    expect(stop.value).toEqual({ name: 'Liva' })
    expect(stop.text).toBe('{"name":"Liva"}')
    // text.format must be set on the streaming request too.
    const p = calls[0]?.params as { text?: { format?: { type?: string } }; stream?: boolean }
    expect(p.stream).toBe(true)
    expect(p.text?.format?.type).toBe('json_schema')
  })
})

// ─── stream() — text deltas + terminal stop ──────────────────────────────

describe('OpenAIResponsesBrainDriver.stream()', () => {
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
