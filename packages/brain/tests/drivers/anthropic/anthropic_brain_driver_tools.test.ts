/**
 * AnthropicBrainDriver tool-shape translation + agentic-loop tests.
 *
 * The real SDK client is replaced by a stub that queues canned
 * responses; tests drive the loop turn-by-turn and assert the
 * params Anthropic would have seen (`tools[]`, `tool_use` /
 * `tool_result` content shapes, etc.).
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { defineTool } from "../../../src/define_tool.ts"
import { AnthropicBrainDriver } from "../../../src/drivers/anthropic/anthropic_brain_driver.ts"
import { ToolExecutionError } from "../../../src/tool_execution_error.ts"

// ─── Fake SDK client ──────────────────────────────────────────────────────

interface ChatCall {
  params: Anthropic.MessageCreateParams
}

function makeTextMessage(text: string): Anthropic.Message {
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
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

function makeToolUseMessage(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [
      { type: 'tool_use', id: toolUseId, name: toolName, input },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

function makeFakeClient(responses: Anthropic.Message[]) {
  const chatCalls: ChatCall[] = []
  const queue = [...responses]
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        chatCalls.push({ params })
        const next = queue.shift()
        if (!next) throw new Error('test: no canned responses left')
        return next
      },
    },
  } as unknown as Anthropic
  return { client, chatCalls }
}

function makeProvider(client: Anthropic) {
  return new AnthropicBrainDriver(
    'anthropic',
    { driver: 'anthropic', apiKey: 'sk-test', defaultModel: 'claude-opus-4-7' },
    { client },
  )
}

// ─── Tool definition translation ─────────────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — tool definition shape', () => {
  test("sends `tools` with each tool's name / description / input_schema", async () => {
    const tool = defineTool({
      name: 'get_weather',
      description: 'Look up the weather.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute: async () => 'sunny',
    })
    const { client, chatCalls } = makeFakeClient([makeTextMessage('done')])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
    const sentTools = chatCalls[0]?.params.tools as Anthropic.Tool[]
    expect(sentTools).toHaveLength(1)
    expect(sentTools[0]?.name).toBe('get_weather')
    expect(sentTools[0]?.description).toBe('Look up the weather.')
    expect((sentTools[0]?.input_schema as { properties: unknown }).properties).toEqual({
      city: { type: 'string' },
    })
  })
})

// ─── No tool use — model answers directly ────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — no tool use', () => {
  test('returns the text + end_turn stop reason without iterations', async () => {
    const { client } = makeFakeClient([makeTextMessage('direct answer')])
    const provider = makeProvider(client)
    const result = await provider.runWithTools([{ role: 'user', content: 'q' }], [])
    expect(result.text).toBe('direct answer')
    expect(result.iterations).toBe(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
  })
})

// ─── One tool round-trip ─────────────────────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — single tool round-trip', () => {
  test('detects tool_use, runs the tool, appends result, re-sends, returns final text', async () => {
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
      makeToolUseMessage('tu_1', 'square', { n: 5 }),
      makeTextMessage('The answer is 25.'),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'what is 5 squared?' }],
      [tool],
    )

    expect(toolCalls).toBe(1)
    expect(result.iterations).toBe(1)
    expect(result.stopReason).toBe('end_turn')
    expect(result.text).toBe('The answer is 25.')

    // First call: just the user prompt.
    expect(chatCalls[0]?.params.messages).toHaveLength(1)

    // Second call: user prompt + assistant tool_use turn + user tool_result turn.
    expect(chatCalls[1]?.params.messages).toHaveLength(3)
    const assistantTurn = chatCalls[1]?.params.messages[1]
    expect(assistantTurn?.role).toBe('assistant')
    const toolResultTurn = chatCalls[1]?.params.messages[2]
    expect(toolResultTurn?.role).toBe('user')
    const resultBlocks = toolResultTurn?.content as Anthropic.ToolResultBlockParam[]
    expect(resultBlocks[0]?.type).toBe('tool_result')
    expect(resultBlocks[0]?.tool_use_id).toBe('tu_1')
    expect(resultBlocks[0]?.content).toBe(JSON.stringify({ result: 25 }))
  })

  test('aggregated usage sums every model call', async () => {
    const tool = defineTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const { client } = makeFakeClient([
      makeToolUseMessage('tu_1', 'noop', {}),
      makeTextMessage('done'),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
    expect(result.usage.inputTokens).toBe(50 + 100)
    expect(result.usage.outputTokens).toBe(10 + 20)
  })
})

// ─── ToolExecutionError ──────────────────────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — error wrapping', () => {
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
      makeToolUseMessage('tu_X', 'broken', {}),
      makeTextMessage('should never run'),
    ])
    const provider = makeProvider(client)
    try {
      await provider.runWithTools([{ role: 'user', content: 'q' }], [tool])
      throw new Error('expected ToolExecutionError')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).context).toEqual({ tool: 'broken', callId: 'tu_X' })
      expect((err as ToolExecutionError).cause).toBeInstanceOf(Error)
      expect(((err as ToolExecutionError).cause as Error).message).toBe('boom inside tool')
    }
  })

  test('unknown tool name → ToolExecutionError before any execute runs', async () => {
    const { client } = makeFakeClient([
      makeToolUseMessage('tu_X', 'not_registered', {}),
      makeTextMessage('unreachable'),
    ])
    const provider = makeProvider(client)
    try {
      await provider.runWithTools([{ role: 'user', content: 'q' }], [])
      throw new Error('expected ToolExecutionError')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).context).toEqual({
        tool: 'not_registered',
        callId: 'tu_X',
      })
      expect(((err as ToolExecutionError).cause as Error).message).toMatch(/not registered/)
    }
  })
})

// ─── maxIterations ───────────────────────────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — maxIterations ceiling', () => {
  test('returns early with stopReason: max_iterations when the model keeps calling tools', async () => {
    const tool = defineTool({
      name: 'loop',
      description: 'always asks for more',
      inputSchema: { type: 'object' },
      execute: async () => 'ack',
    })
    // The loop wants to keep going indefinitely — keep feeding tool_use
    // responses so the iteration ceiling fires.
    const { client, chatCalls } = makeFakeClient([
      makeToolUseMessage('tu_1', 'loop', {}),
      makeToolUseMessage('tu_2', 'loop', {}),
      makeToolUseMessage('tu_3', 'loop', {}),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools(
      [{ role: 'user', content: 'q' }],
      [tool],
      { maxIterations: 2 },
    )
    expect(result.stopReason).toBe('max_iterations')
    expect(result.iterations).toBe(2)
    // Two model calls (the third never fires — we hit the ceiling
    // after appending the second tool_result).
    expect(chatCalls).toHaveLength(2)
  })
})

// ─── Tool context propagation ────────────────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — context propagation', () => {
  test('options.context flows into tool.execute(_, ctx).context', async () => {
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
      makeToolUseMessage('tu_1', 'who', {}),
      makeTextMessage('done'),
    ])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [tool], {
      context: { userId: 'u-42' },
    })
    expect(seenUserId).toBe('u-42')
  })
})
