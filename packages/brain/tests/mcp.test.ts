/**
 * MCP tests — config plumbing through BrainManager and translation
 * on the AnthropicBrainDriver.
 *
 * Provider behavior — the SDK request shape Anthropic actually sees,
 * MCP block translation — uses a stub `Anthropic` client. The
 * agentic loop itself is covered in `anthropic_provider_tools.test.ts`;
 * this file focuses on the MCP-specific extensions.
 */

import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { BrainManager } from '../src/brain_manager.ts'
import type { MCPServer } from '../src/mcp_server.ts'
import { AnthropicBrainDriver } from '../src/drivers/anthropic/anthropic_brain_driver.ts'
import type { BrainDriver, RunWithToolsOptions } from '../src/brain_driver.ts'
import type { AgentResult } from '../src/agent_result.ts'
import type { Tool } from '../src/tool.ts'
import type { ChatResult, Message, StreamEvent } from '../src/types.ts'

// ─── BrainManager defaults + per-call routing ────────────────────────────

class StubProvider implements BrainDriver {
  readonly name = 'stub'
  readonly calls: Array<{
    messages: readonly Message[]
    tools: readonly Tool[]
    options: RunWithToolsOptions | undefined
  }> = []
  async chat(): Promise<ChatResult> {
    throw new Error('not used')
  }
  async *stream(): AsyncIterable<StreamEvent> {}
  async runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): Promise<AgentResult> {
    this.calls.push({ messages, tools, options })
    return {
      text: '',
      messages: [],
      iterations: 0,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    }
  }
}

const linearServer: MCPServer = { name: 'linear', url: 'https://mcp.linear.app/sse' }
const notionServer: MCPServer = { name: 'notion', url: 'https://mcp.notion.com/sse' }

describe('BrainManager — MCP server defaults', () => {
  test('defaultMcpServers fills in when the call site omits mcpServers', async () => {
    const stub = new StubProvider()
    const brain = new BrainManager({
      default: 'stub',
      providers: { stub },
      defaultMcpServers: [linearServer],
    })
    await brain.runTools('hi', [])
    expect(stub.calls[0]?.options?.mcpServers).toEqual([linearServer])
  })

  test('per-call mcpServers replaces the default outright (no merge)', async () => {
    const stub = new StubProvider()
    const brain = new BrainManager({
      default: 'stub',
      providers: { stub },
      defaultMcpServers: [linearServer],
    })
    await brain.runTools('hi', [], { mcpServers: [notionServer] })
    expect(stub.calls[0]?.options?.mcpServers).toEqual([notionServer])
  })

  test('empty per-call mcpServers replaces the default with an empty list', async () => {
    const stub = new StubProvider()
    const brain = new BrainManager({
      default: 'stub',
      providers: { stub },
      defaultMcpServers: [linearServer],
    })
    await brain.runTools('hi', [], { mcpServers: [] })
    // Empty array passed explicitly — provider sees what the app sent.
    expect(stub.calls[0]?.options?.mcpServers).toEqual([])
  })
})

// ─── AnthropicBrainDriver — request translation ─────────────────────────────

interface ChatCall {
  params: Anthropic.MessageCreateParams & {
    mcp_servers?: unknown[]
    betas?: readonly string[]
  }
  surface: 'beta' | 'plain'
}

function makeMessage(
  text: string,
  extras: { content?: unknown[]; stopReason?: string } = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: extras.content ?? [{ type: 'text', text, citations: null }],
    stop_reason: extras.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message
}

function makeClient(responses: Anthropic.Message[]) {
  const chatCalls: ChatCall[] = []
  const queue = [...responses]
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        chatCalls.push({ params: params as ChatCall['params'], surface: 'plain' })
        const next = queue.shift()
        if (!next) throw new Error('out of responses')
        return next
      },
    },
    beta: {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          chatCalls.push({ params: params as ChatCall['params'], surface: 'beta' })
          const next = queue.shift()
          if (!next) throw new Error('out of responses')
          return next
        },
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

describe('AnthropicBrainDriver.runWithTools — MCP request shape', () => {
  test('no MCP servers → uses the plain (non-beta) messages.create surface', async () => {
    const { client, chatCalls } = makeClient([makeMessage('hi')])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [])
    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0]?.surface).toBe('plain')
    expect((chatCalls[0]?.params as { mcp_servers?: unknown }).mcp_servers).toBeUndefined()
  })

  test('with MCP servers → uses the beta surface + adds the mcp-client beta header', async () => {
    const { client, chatCalls } = makeClient([makeMessage('hi')])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [], {
      mcpServers: [linearServer],
    })
    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0]?.surface).toBe('beta')
    expect(chatCalls[0]?.params.betas).toEqual(['mcp-client-2025-11-20'])
  })

  test('MCP servers translate to mcp_servers + mcp_toolset tool entries', async () => {
    const { client, chatCalls } = makeClient([makeMessage('hi')])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [], {
      mcpServers: [
        { ...linearServer, authorizationToken: 'tok_123' },
        { ...notionServer, tools: { allowedTools: ['search', 'create_page'] } },
      ],
    })
    const params = chatCalls[0]?.params as ChatCall['params']
    expect(params.mcp_servers).toEqual([
      { type: 'url', name: 'linear', url: 'https://mcp.linear.app/sse', authorization_token: 'tok_123' },
      { type: 'url', name: 'notion', url: 'https://mcp.notion.com/sse' },
    ])
    // mcp_toolset is a beta-only tool type — assert on the raw shape
    // by widening through `unknown`.
    expect(params.tools as unknown).toEqual([
      { type: 'mcp_toolset', mcp_server_name: 'linear' },
      { type: 'mcp_toolset', mcp_server_name: 'notion', allowed_tools: ['search', 'create_page'] },
    ])
  })

  test('servers with tools.enabled === false are skipped from the tools array but still declared', async () => {
    const { client, chatCalls } = makeClient([makeMessage('hi')])
    const provider = makeProvider(client)
    await provider.runWithTools([{ role: 'user', content: 'q' }], [], {
      mcpServers: [
        { ...linearServer, tools: { enabled: false } },
        notionServer,
      ],
    })
    const params = chatCalls[0]?.params as ChatCall['params']
    // Both servers declared so the connector knows about them …
    expect(params.mcp_servers).toHaveLength(2)
    // … but only the enabled one routes model tool calls.
    expect(params.tools as unknown).toEqual([{ type: 'mcp_toolset', mcp_server_name: 'notion' }])
  })

  test('local tools and MCP toolsets coexist on the same request', async () => {
    const { client, chatCalls } = makeClient([makeMessage('hi')])
    const provider = makeProvider(client)
    const localTool = {
      name: 'add',
      description: 'add two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
      },
      execute: async () => 0,
    } satisfies Tool
    await provider.runWithTools([{ role: 'user', content: 'q' }], [localTool], {
      mcpServers: [linearServer],
    })
    const tools = chatCalls[0]?.params.tools as Array<{ type?: string; name?: string }>
    expect(tools).toHaveLength(2)
    expect(tools[0]?.name).toBe('add')
    expect(tools[1]?.type).toBe('mcp_toolset')
  })
})

// ─── AnthropicBrainDriver — response surface ────────────────────────────────

describe('AnthropicBrainDriver.runWithTools — MCP response blocks', () => {
  test('mcp_tool_use and mcp_tool_result blocks surface on result.messages', async () => {
    const { client } = makeClient([
      makeMessage('done', {
        content: [
          { type: 'text', text: 'I checked Linear for you.', citations: null },
          {
            type: 'mcp_tool_use',
            id: 'mcp_1',
            server_name: 'linear',
            name: 'list_issues',
            input: { project: 'STR' },
          },
          {
            type: 'mcp_tool_result',
            tool_use_id: 'mcp_1',
            content: [{ type: 'text', text: '3 open issues' }],
            is_error: false,
          },
        ],
      }),
    ])
    const provider = makeProvider(client)
    const result = await provider.runWithTools([{ role: 'user', content: 'q' }], [], {
      mcpServers: [linearServer],
    })
    expect(result.stopReason).toBe('end_turn')
    const assistantTurn = result.messages[result.messages.length - 1]
    expect(Array.isArray(assistantTurn?.content)).toBe(true)
    const blocks = assistantTurn?.content as Array<{ type: string }>
    expect(blocks.map((b) => b.type)).toEqual(['text', 'mcp_tool_use', 'mcp_tool_result'])
    const mcpUse = blocks.find((b) => b.type === 'mcp_tool_use') as unknown as {
      serverName: string
      name: string
      input: unknown
    }
    expect(mcpUse.serverName).toBe('linear')
    expect(mcpUse.name).toBe('list_issues')
    expect(mcpUse.input).toEqual({ project: 'STR' })
    const mcpResult = blocks.find((b) => b.type === 'mcp_tool_result') as unknown as {
      toolUseId: string
      content: Array<{ type: 'text'; text: string }>
    }
    expect(mcpResult.toolUseId).toBe('mcp_1')
    expect(mcpResult.content).toEqual([{ type: 'text', text: '3 open issues' }])
  })
})
