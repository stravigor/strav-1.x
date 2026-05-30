/**
 * `GeminiBrainDriver` tests — shape translation + agentic-loop behavior.
 *
 * The real `GoogleGenAI` client is replaced by a stub that queues
 * canned responses; tests drive the loop turn-by-turn and assert the
 * params the SDK would have seen (systemInstruction placement,
 * functionDeclarations wrapping, functionCall→tool_use translation,
 * functionResponse fan-out, thinkingConfig mapping).
 */

import { describe, expect, test } from 'bun:test'
import { ThinkingLevel } from '@google/genai'
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import { defineTool } from "../../../src/define_tool.ts"
import type { MCPClient, MCPToolDescriptor } from "../../../src/mcp/client.ts"
import { GeminiBrainDriver } from "../../../src/drivers/gemini/gemini_brain_driver.ts"
import { ToolExecutionError } from "../../../src/tool_execution_error.ts"
import type { StreamEvent } from "../../../src/types.ts"

// ─── Fake SDK client ──────────────────────────────────────────────────────

interface GenerateCall {
  params: GenerateContentParameters
}

function makeResponse(opts: {
  text?: string
  functionCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>
  finishReason?: string
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
  modelVersion?: string
}): GenerateContentResponse {
  const parts: Array<{ text?: string; functionCall?: { id?: string; name: string; args: Record<string, unknown> } }> = []
  if (opts.text) parts.push({ text: opts.text })
  for (const fc of opts.functionCalls ?? []) {
    parts.push({ functionCall: fc })
  }
  return {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason: opts.finishReason,
      },
    ],
    usageMetadata: opts.usage,
    modelVersion: opts.modelVersion ?? 'gemini-2.5-flash-001',
  } as unknown as GenerateContentResponse
}

function makeFakeClient(
  responses: GenerateContentResponse[],
  streamResponse?: AsyncIterable<GenerateContentResponse>,
) {
  const generateCalls: GenerateCall[] = []
  const countCalls: Array<{ model: string; contents: unknown }> = []
  const queue = [...responses]
  const client = {
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        generateCalls.push({ params })
        const next = queue.shift()
        if (!next) throw new Error('test: no canned responses left')
        return next
      },
      generateContentStream: async (params: GenerateContentParameters) => {
        generateCalls.push({ params })
        return streamResponse ?? { async *[Symbol.asyncIterator]() {} }
      },
      countTokens: async (params: { model: string; contents: unknown }) => {
        countCalls.push(params)
        return { totalTokens: 42 }
      },
    },
  }
  return { client, generateCalls, countCalls }
}

function makeProvider(client: ReturnType<typeof makeFakeClient>['client']) {
  return new GeminiBrainDriver(
    'google',
    { driver: 'google', apiKey: 'sk-test' },
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
    description: `Linear ${name}`,
    inputSchema: { type: 'object' },
  }))
  const fake: FakeMcpClient = {
    closed: false,
    async listTools() { return descriptors },
    async callTool(name, input) {
      callRecord.push({ name, input })
      const r = responses[name]
      if (!r) throw new Error(`fake mcp: no response for ${name}`)
      return r
    },
    async close() { fake.closed = true },
  }
  return fake
}

// ─── chat — translation ──────────────────────────────────────────────────

describe('GeminiBrainDriver — chat() request shape', () => {
  test('plain prompt becomes a single user Content with one text part', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'hi' })])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'hello' }])
    expect(result.text).toBe('hi')
    expect(generateCalls[0]?.params.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ])
  })

  test('assistant role maps to "model"', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ack' })])
    const provider = makeProvider(client)
    await provider.chat([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'prior' },
      { role: 'user', content: 'follow up' },
    ])
    expect(generateCalls[0]?.params.contents).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ text: 'prior' }] },
      { role: 'user', parts: [{ text: 'follow up' }] },
    ])
  })

  test('system string → config.systemInstruction', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { system: 'be brief' })
    expect(generateCalls[0]?.params.config?.systemInstruction).toBe('be brief')
  })

  test('multi-block system joins with newlines', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], {
      system: [{ text: 'rule 1' }, { text: 'rule 2' }],
    })
    expect(generateCalls[0]?.params.config?.systemInstruction).toBe('rule 1\nrule 2')
  })

  test('thinking: adaptive → thinkingBudget: -1', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { thinking: 'adaptive' })
    expect(generateCalls[0]?.params.config?.thinkingConfig).toEqual({ thinkingBudget: -1 })
  })

  test('thinking: disabled → thinkingBudget: 0', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { thinking: 'disabled' })
    expect(generateCalls[0]?.params.config?.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  test('effort wins over thinking', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { effort: 'high', thinking: 'disabled' })
    expect(generateCalls[0]?.params.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.HIGH })
  })

  test('maxTokens → config.maxOutputTokens; default model + maxTokens applied', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }])
    expect(generateCalls[0]?.params.model).toBe('gemini-2.5-flash')
    expect(generateCalls[0]?.params.config?.maxOutputTokens).toBe(4096)
  })

  test('cache: true is silently no-op', async () => {
    const { client, generateCalls } = makeFakeClient([makeResponse({ text: 'ok' })])
    const provider = makeProvider(client)
    await provider.chat([{ role: 'user', content: 'q' }], { cache: true })
    expect(generateCalls[0]?.params.config).toBeDefined()
    expect((generateCalls[0]?.params.config as { cache?: unknown }).cache).toBeUndefined()
  })
})

// ─── ChatResult mapping ──────────────────────────────────────────────────

describe('GeminiBrainDriver — chat() result mapping', () => {
  test('usage metadata flows into ChatUsage incl. cache reads', async () => {
    const { client } = makeFakeClient([
      makeResponse({
        text: 'hi',
        finishReason: 'STOP',
        usage: { promptTokenCount: 12, candidatesTokenCount: 7, cachedContentTokenCount: 3 },
      }),
    ])
    const provider = makeProvider(client)
    const result = await provider.chat([{ role: 'user', content: 'q' }])
    expect(result.stopReason).toBe('STOP')
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
    })
  })
})

// ─── stream ──────────────────────────────────────────────────────────────

describe('GeminiBrainDriver — stream()', () => {
  test('emits text deltas then a terminal stop event', async () => {
    const events: GenerateContentResponse[] = [
      makeResponse({ text: 'hel' }),
      makeResponse({ text: 'lo' }),
      makeResponse({
        text: '',
        finishReason: 'STOP',
        usage: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    ]
    async function* streamGen() { for (const e of events) yield e }
    const { client } = makeFakeClient([], streamGen())
    const provider = makeProvider(client)
    const collected: StreamEvent[] = []
    for await (const e of provider.stream([{ role: 'user', content: 'q' }])) {
      collected.push(e)
    }
    expect(collected).toEqual([
      { type: 'text', delta: 'hel' },
      { type: 'text', delta: 'lo' },
      {
        type: 'stop',
        stopReason: 'STOP',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ])
  })
})

// ─── countTokens ─────────────────────────────────────────────────────────

describe('GeminiBrainDriver — countTokens()', () => {
  test('returns totalTokens from the SDK', async () => {
    const { client, countCalls } = makeFakeClient([])
    const provider = makeProvider(client)
    const n = await provider.countTokens([{ role: 'user', content: 'how many?' }])
    expect(n).toBe(42)
    expect(countCalls[0]?.model).toBe('gemini-2.5-flash')
  })
})

// ─── runWithTools — agentic loop ─────────────────────────────────────────

describe('GeminiBrainDriver — runWithTools()', () => {
  test('tool definitions are translated into functionDeclarations', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echoes input',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async (i: { x: string }) => i.x,
    })
    const { client, generateCalls } = makeFakeClient([
      makeResponse({ text: 'done', finishReason: 'STOP' }),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
    expect(generateCalls[0]?.params.config?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'echo',
            description: 'echoes input',
            parametersJsonSchema: { type: 'object', properties: { x: { type: 'string' } } },
          },
        ],
      },
    ])
  })

  test('executes a tool, fans the result back as functionResponse, completes', async () => {
    const tool = defineTool({
      name: 'add',
      description: 'adds',
      inputSchema: { type: 'object' },
      execute: async (i: { a: number; b: number }) => i.a + i.b,
    })
    const { client, generateCalls } = makeFakeClient([
      makeResponse({
        functionCalls: [{ id: 'call_1', name: 'add', args: { a: 2, b: 3 } }],
        finishReason: 'STOP',
      }),
      makeResponse({ text: '5', finishReason: 'STOP' }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools([{ role: 'user', content: '2+3' }], [tool])
    expect(result.text).toBe('5')
    expect(result.iterations).toBe(1)
    // Second call must include the functionResponse part fed back to the model.
    const secondContents = generateCalls[1]?.params.contents as Array<{ role: string; parts: Array<{ functionResponse?: { id?: string; name?: string; response: unknown } }> }>
    const lastTurn = secondContents.at(-1)
    expect(lastTurn?.role).toBe('user')
    expect(lastTurn?.parts[0]?.functionResponse).toEqual({
      id: 'call_1',
      name: '',
      response: { result: '5' },
    })
  })

  test('unknown tool name → ToolExecutionError', async () => {
    const { client } = makeFakeClient([
      makeResponse({
        functionCalls: [{ id: 'call_x', name: 'ghost', args: {} }],
        finishReason: 'STOP',
      }),
    ])
    const provider = makeProvider(client)
    await expect(
      provider.runWithTools([{ role: 'user', content: 'q' }], []),
    ).rejects.toBeInstanceOf(ToolExecutionError)
  })

  test('maxIterations bounds the loop', async () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: { type: 'object' },
      execute: async () => 'r',
    })
    const { client } = makeFakeClient([
      makeResponse({ functionCalls: [{ id: '1', name: 't', args: {} }] }),
      makeResponse({ functionCalls: [{ id: '2', name: 't', args: {} }] }),
      makeResponse({ functionCalls: [{ id: '3', name: 't', args: {} }] }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { maxIterations: 2 },
    )
    expect(result.stopReason).toBe('max_iterations')
    expect(result.iterations).toBe(2)
  })

  test('options.mcpServers resolves into namespaced tools via local client', async () => {
    const { client, generateCalls } = makeFakeClient([
      makeResponse({
        functionCalls: [{ id: 'call_1', name: 'linear__list_issues', args: { limit: 3 } }],
        finishReason: 'STOP',
      }),
      makeResponse({ text: 'three open issues', finishReason: 'STOP' }),
    ])
    const callRecord: Array<{ name: string; input: unknown }> = []
    const fakeMcp = makeFakeMcpClient(
      { list_issues: { content: '["a","b","c"]', isError: false } },
      callRecord,
    )
    const provider = new GeminiBrainDriver(
      'google',
      { driver: 'google', apiKey: 'sk-test' },
      { client, mcpClientFactory: () => fakeMcp as unknown as MCPClient },
    )
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'list issues' }],
      [],
      { mcpServers: [{ name: 'linear', url: 'https://mcp.linear.app' }] },
    )
    expect(result.text).toBe('three open issues')
    expect(generateCalls[0]?.params.config?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'linear__list_issues',
            description: 'Linear list_issues',
            parametersJsonSchema: { type: 'object' },
          },
        ],
      },
    ])
    expect(callRecord).toEqual([{ name: 'list_issues', input: { limit: 3 } }])
    expect(fakeMcp.closed).toBe(true)
  })

  test('context is threaded into tool.execute(_, ctx).context', async () => {
    let seenUserId: unknown
    const tool = defineTool({
      name: 'who',
      description: 'reads context',
      inputSchema: { type: 'object' },
      execute: async (_input, ctx) => {
        seenUserId = ctx.context.userId
        return 'ok'
      },
    })
    const { client } = makeFakeClient([
      makeResponse({ functionCalls: [{ id: 'c', name: 'who', args: {} }] }),
      makeResponse({ text: 'done', finishReason: 'STOP' }),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool], {
      context: { userId: 'u_42' },
    })
    expect(seenUserId).toBe('u_42')
  })
})
