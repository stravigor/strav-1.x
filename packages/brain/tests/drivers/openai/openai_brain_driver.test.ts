/**
 * `OpenAIBrainDriver` tests — shape translation + agentic-loop behavior.
 *
 * The real `OpenAI` client is replaced by a stub that queues canned
 * responses; tests drive the loop turn-by-turn and assert the params
 * the SDK would have seen (system prompt placement, tool definition
 * wrapping, tool result fan-out into `tool`-role messages, etc.).
 */

import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'
import { defineTool } from "../../../src/define_tool.ts"
import type { MCPClient, MCPToolDescriptor } from "../../../src/mcp/client.ts"
import { OpenAIBrainDriver } from "../../../src/drivers/openai/openai_brain_driver.ts"
import { ToolExecutionError } from "../../../src/tool_execution_error.ts"
import type { StreamEvent } from "../../../src/types.ts"

// ─── Fake SDK client ──────────────────────────────────────────────────────

interface ChatCall {
  params: OpenAI.Chat.ChatCompletionCreateParams
}

function makeCompletion(
  text: string,
  extras: {
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
    finishReason?: string
  } = {},
): OpenAI.Chat.ChatCompletion {
  const message: OpenAI.Chat.ChatCompletionMessage = {
    role: 'assistant',
    content: text || null,
    refusal: null,
  } as unknown as OpenAI.Chat.ChatCompletionMessage
  if (extras.toolCalls) {
    ;(message as { tool_calls?: unknown }).tool_calls = extras.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }))
  }
  return {
    id: 'cmpl_test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5',
    choices: [
      {
        index: 0,
        message,
        finish_reason: extras.finishReason ?? (extras.toolCalls ? 'tool_calls' : 'stop'),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 10,
      total_tokens: 60,
      prompt_tokens_details: { cached_tokens: 5 } as OpenAI.CompletionUsage.PromptTokensDetails,
    },
  } as unknown as OpenAI.Chat.ChatCompletion
}

interface StreamEventStub {
  type?: 'chunk'
  choices: Array<{
    delta: { content?: string }
    finish_reason: string | null
  }>
  usage?: OpenAI.CompletionUsage
}

function makeFakeStream(
  deltas: string[],
  finalUsage: OpenAI.CompletionUsage,
): AsyncIterable<StreamEventStub> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEventStub> {
      for (let i = 0; i < deltas.length; i++) {
        yield {
          choices: [{ delta: { content: deltas[i] }, finish_reason: null }],
        }
      }
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: finalUsage,
      }
    },
  }
}

function makeFakeClient(
  responses: OpenAI.Chat.ChatCompletion[],
  streamResponse?: AsyncIterable<StreamEventStub>,
) {
  const chatCalls: ChatCall[] = []
  const queue = [...responses]
  const client = {
    chat: {
      completions: {
        create: async (params: OpenAI.Chat.ChatCompletionCreateParams) => {
          chatCalls.push({ params })
          if ((params as { stream?: boolean }).stream === true) {
            return streamResponse ?? { async *[Symbol.asyncIterator]() {} }
          }
          const next = queue.shift()
          if (!next) throw new Error('test: no canned responses left')
          return next
        },
      },
    },
  } as unknown as OpenAI
  return { client, chatCalls }
}

function makeProvider(client: OpenAI) {
  return new OpenAIBrainDriver(
    'openai',
    { driver: 'openai', apiKey: 'sk-test' },
    { client },
  )
}

interface FakeMcpClient {
  listTools(): Promise<MCPToolDescriptor[]>
  callTool(name: string, input: unknown): Promise<{ content: string; isError: boolean }>
  close(): Promise<void>
  closed: boolean
}

function makeFakeMcpClient(
  responses: Record<string, { content: string; isError: boolean }>,
  callRecord: Array<{ name: string; input: unknown }> = [],
): FakeMcpClient {
  const descriptors: MCPToolDescriptor[] = Object.keys(responses).map((name) => ({
    name,
    description: `List Linear ${name.replace(/^list_/, '')}`,
    inputSchema: { type: 'object' },
  }))
  const fake: FakeMcpClient = {
    closed: false,
    async listTools() {
      return descriptors
    },
    async callTool(name, input) {
      callRecord.push({ name, input })
      const response = responses[name]
      if (!response) throw new Error(`fake mcp: no response for ${name}`)
      return response
    },
    async close() {
      fake.closed = true
    },
  }
  return fake
}

// ─── chat — translation in / out ─────────────────────────────────────────

describe('OpenAIBrainDriver — chat() request shape', () => {
  test('system prompt becomes the first message with role: system', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'hi' }], { system: 'be helpful' })
    expect(chatCalls[0]?.params.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(chatCalls[0]?.params.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  test('no system prompt → just the user message goes through', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(chatCalls[0]?.params.messages).toHaveLength(1)
    expect(chatCalls[0]?.params.messages[0]).toEqual({ role: 'user', content: 'q' })
  })

  test('cached system prompt (cache: true) still becomes a plain system message — OpenAI auto-caches', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      system: { text: 'large system prompt', cache: true },
    })
    // The cache flag is silently dropped; the system text still
    // lands as a normal system message.
    expect(chatCalls[0]?.params.messages[0]).toEqual({
      role: 'system',
      content: 'large system prompt',
    })
  })

  test('multi-block system prompt joins with newlines', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      system: [{ text: 'one' }, { text: 'two' }],
    })
    expect((chatCalls[0]?.params.messages[0] as { content: string }).content).toBe('one\ntwo')
  })

  test('uses defaultModel when options.model is not set', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-5' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(chatCalls[0]?.params.model).toBe('gpt-5')
  })

  test('explicit model option wins over defaultModel', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-5' },
      { client },
    )
    await provider.chat([{ role: 'user', content: 'q' }], { model: 'gpt-4o' })
    expect(chatCalls[0]?.params.model).toBe('gpt-4o')
  })

  test("thinking 'adaptive' maps to reasoning_effort: medium", async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { thinking: 'adaptive' })
    expect(chatCalls[0]?.params.reasoning_effort).toBe('medium')
  })

  test('explicit effort wins over thinking mapping', async () => {
    const { client, chatCalls } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      thinking: 'adaptive',
      effort: 'high',
    })
    expect(chatCalls[0]?.params.reasoning_effort).toBe('high')
  })
})

// ─── chat — response translation ─────────────────────────────────────────

describe('OpenAIBrainDriver — chat() response shape', () => {
  test('flattens assistant content into ChatResult.text', async () => {
    const { client } = makeFakeClient([makeCompletion('hello world')])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.text).toBe('hello world')
  })

  test('surfaces cache hit tokens via prompt_tokens_details', async () => {
    const { client } = makeFakeClient([makeCompletion('reply')])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
    })
  })

  test('null assistant content → empty text', async () => {
    const { client } = makeFakeClient([makeCompletion('')])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.text).toBe('')
  })
})

// ─── stream() ────────────────────────────────────────────────────────────

describe('OpenAIBrainDriver — stream()', () => {
  test('yields text events per delta then a final stop event', async () => {
    const stream = makeFakeStream(['hel', 'lo'], {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 1 } as OpenAI.CompletionUsage.PromptTokensDetails,
    })
    const { client } = makeFakeClient([], stream)
    const provider = makeProvider(client)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream([{ role: 'user', content: 'q' }])) {
      events.push(ev)
    }
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ type: 'text', delta: 'hel' })
    expect(events[1]).toEqual({ type: 'text', delta: 'lo' })
    const stop = events[2]
    expect(stop?.type).toBe('stop')
    if (stop?.type !== 'stop') throw new Error('expected stop')
    expect(stop.stopReason).toBe('stop')
    expect(stop.usage.inputTokens).toBe(5)
    expect(stop.usage.cacheReadTokens).toBe(1)
  })

  test('adds stream_options: include_usage so the final chunk carries usage', async () => {
    const stream = makeFakeStream([], {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    })
    const { client, chatCalls } = makeFakeClient([], stream)
    const provider = makeProvider(client)
    for await (const _ of provider.stream([{ role: 'user', content: 'q' }])) {
      // drain
    }
    expect((chatCalls[0]?.params as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage).toBe(true)
  })
})

// ─── runWithTools ───────────────────────────────────────────────────────

describe('OpenAIBrainDriver — runWithTools()', () => {
  test('wraps tools in the function namespace and passes parameters from inputSchema', async () => {
    const tool = defineTool({
      name: 'get_weather',
      description: 'Get the weather.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute: async () => 'sunny',
    })
    const { client, chatCalls } = makeFakeClient([makeCompletion('done', { finishReason: 'stop' })])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
    const tools = (chatCalls[0]?.params as { tools?: unknown[] }).tools as Array<{
      type: string
      function: { name: string; description: string; parameters: unknown }
    }>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.type).toBe('function')
    expect(tools[0]?.function.name).toBe('get_weather')
    expect(tools[0]?.function.description).toBe('Get the weather.')
    expect((tools[0]?.function.parameters as { type: string }).type).toBe('object')
  })

  test('single tool round-trip: detects tool_calls, runs the tool, appends tool message, re-asks', async () => {
    let toolCalls = 0
    const tool = defineTool({
      name: 'square',
      description: 'Square a number.',
      inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      execute: async (input: { n: number }) => {
        toolCalls++
        return { result: input.n * input.n }
      },
    })
    const { client, chatCalls } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [{ id: 'call_1', name: 'square', arguments: '{"n": 5}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('The answer is 25.', { finishReason: 'stop' }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'what is 5 squared?' }],
      [tool],
    )
    expect(toolCalls).toBe(1)
    expect(result.iterations).toBe(1)
    expect(result.text).toBe('The answer is 25.')

    // Second call must include: original user, assistant (with
    // tool_calls), tool message with the result.
    const secondCallMessages = chatCalls[1]?.params.messages as OpenAI.Chat.ChatCompletionMessageParam[]
    expect(secondCallMessages).toHaveLength(3)
    expect(secondCallMessages[0]?.role).toBe('user')
    expect(secondCallMessages[1]?.role).toBe('assistant')
    const assistantMsg = secondCallMessages[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam
    expect(assistantMsg.tool_calls?.[0]?.id).toBe('call_1')
    expect(secondCallMessages[2]?.role).toBe('tool')
    const toolMsg = secondCallMessages[2] as OpenAI.Chat.ChatCompletionToolMessageParam
    expect(toolMsg.tool_call_id).toBe('call_1')
    expect(toolMsg.content).toBe(JSON.stringify({ result: 25 }))
  })

  test('multiple tool calls in one assistant turn fan out into separate tool messages', async () => {
    const tool = defineTool({
      name: 'noop',
      description: 'returns ok',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const { client, chatCalls } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [
          { id: 'call_1', name: 'noop', arguments: '{}' },
          { id: 'call_2', name: 'noop', arguments: '{}' },
        ],
        finishReason: 'tool_calls',
      }),
      makeCompletion('done', { finishReason: 'stop' }),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
    const secondCall = chatCalls[1]?.params.messages as OpenAI.Chat.ChatCompletionMessageParam[]
    const toolMsgs = secondCall.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect((toolMsgs[0] as { tool_call_id: string }).tool_call_id).toBe('call_1')
    expect((toolMsgs[1] as { tool_call_id: string }).tool_call_id).toBe('call_2')
  })

  test('tool throws → ToolExecutionError with name + callId + cause', async () => {
    const tool = defineTool({
      name: 'broken',
      description: 'always throws',
      inputSchema: { type: 'object' },
      execute: async () => {
        throw new Error('boom inside tool')
      },
    })
    const { client } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [{ id: 'call_X', name: 'broken', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('unreachable', { finishReason: 'stop' }),
    ])
    const provider = makeProvider(client)
    try {
      await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
      throw new Error('expected ToolExecutionError')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).context).toEqual({ tool: 'broken', callId: 'call_X' })
    }
  })

  test('unknown tool name → ToolExecutionError before any execute', async () => {
    const { client } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [{ id: 'call_X', name: 'not_registered', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('unreachable', { finishReason: 'stop' }),
    ])
    const provider = makeProvider(client)
    try {
      await provider.runWithTools([{ role: 'user', content: 'q' }], [])
      throw new Error('expected ToolExecutionError')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
    }
  })

  test('aggregated usage sums every model call (incl. cache reads)', async () => {
    const tool = defineTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const { client } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [{ id: 'call_1', name: 'noop', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('done', { finishReason: 'stop' }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
    // Each canned response carries prompt=50, completion=10, cached=5.
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
    expect(result.usage.cacheReadTokens).toBe(10)
  })

  test('maxIterations ceiling → stopReason: max_iterations + iterations === ceiling', async () => {
    const tool = defineTool({
      name: 'loop',
      description: 'asks for more',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const { client, chatCalls } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [{ id: 'call_1', name: 'loop', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('', {
        toolCalls: [{ id: 'call_2', name: 'loop', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('', {
        toolCalls: [{ id: 'call_3', name: 'loop', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { maxIterations: 2 },
    )
    expect(result.stopReason).toBe('max_iterations')
    expect(result.iterations).toBe(2)
    expect(chatCalls).toHaveLength(2)
  })

  test('options.mcpServers (non-empty) resolves into tools via the local MCP client', async () => {
    // First completion calls the MCP tool; second completion is the
    // model's follow-up after seeing the tool result.
    const { client, chatCalls } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [
          { id: 'call_1', name: 'linear__list_issues', arguments: '{"limit":3}' },
        ],
        finishReason: 'tool_calls',
      }),
      makeCompletion('three open issues', { finishReason: 'stop' }),
    ])
    const callRecord: Array<{ name: string; input: unknown }> = []
    const fakeMcp = makeFakeMcpClient({
      list_issues: { content: '["a","b","c"]', isError: false },
    }, callRecord)
    const provider = new OpenAIBrainDriver(
      'openai',
      { driver: 'openai', apiKey: 'sk-test' },
      { client, mcpClientFactory: () => fakeMcp as unknown as MCPClient },
    )
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'list issues' }],
      [],
      { mcpServers: [{ name: 'linear', url: 'https://mcp.linear.app' }] },
    )
    expect(result.text).toBe('three open issues')
    expect(chatCalls[0]?.params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'linear__list_issues',
          description: 'List Linear issues',
          parameters: { type: 'object' },
        },
      },
    ])
    expect(callRecord).toEqual([{ name: 'list_issues', input: { limit: 3 } }])
    expect(fakeMcp.closed).toBe(true)
  })

  test('options.mcpServers === [] is fine — empty list is a no-op', async () => {
    const { client } = makeFakeClient([makeCompletion('done', { finishReason: 'stop' })])
    const provider = makeProvider(client)
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [],
      { mcpServers: [] },
    )
    expect(result.text).toBe('done')
  })

  test('options.context propagates into tool.execute(_, ctx).context', async () => {
    let seenUserId: unknown
    const tool = defineTool({
      name: 'who',
      description: 'reads ctx.context.userId',
      inputSchema: { type: 'object' },
      execute: async (_input, ctx) => {
        seenUserId = ctx.context.userId
        return { ok: true }
      },
    })
    const { client } = makeFakeClient([
      makeCompletion('', {
        toolCalls: [{ id: 'call_1', name: 'who', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      makeCompletion('done', { finishReason: 'stop' }),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool], {
      context: { userId: 'u-42' },
    })
    expect(seenUserId).toBe('u-42')
  })
})
