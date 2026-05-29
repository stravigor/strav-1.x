/**
 * `MCPClient` + `resolveMcpTools` tests — verified against a stub
 * `@modelcontextprotocol/sdk` `Client` so no network is touched.
 */

import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { BrainError } from '../src/brain_error.ts'
import { MCPClient } from '../src/mcp/client.ts'
import { resolveMcpTools } from '../src/mcp/resolve_mcp_tools.ts'
import type { MCPServer } from '../src/mcp_server.ts'

interface ConnectCall {
  transport: unknown
}

function makeFakeSdkClient(opts: {
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  callResponses?: Record<string, { content: unknown; isError?: boolean }>
  connectThrows?: Error
  listThrows?: Error
  callThrows?: Error
} = {}) {
  const connectCalls: ConnectCall[] = []
  const callRecord: Array<{ name: string; arguments: unknown }> = []
  let closed = false
  const fake = {
    async connect(transport: unknown) {
      connectCalls.push({ transport })
      if (opts.connectThrows) throw opts.connectThrows
    },
    async listTools() {
      if (opts.listThrows) throw opts.listThrows
      return {
        tools: (opts.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: 'object' },
        })),
      }
    },
    async callTool(params: { name: string; arguments?: unknown }) {
      if (opts.callThrows) throw opts.callThrows
      callRecord.push({ name: params.name, arguments: params.arguments })
      const r = opts.callResponses?.[params.name]
      if (!r) throw new Error(`fake sdk: no response for ${params.name}`)
      return { content: r.content, isError: r.isError ?? false }
    },
    async close() {
      closed = true
    },
  } as unknown as Client
  return { fake, connectCalls, callRecord, isClosed: () => closed }
}

const server: MCPServer = {
  name: 'linear',
  url: 'https://mcp.linear.app',
  authorizationToken: 'test-token',
}

describe('MCPClient', () => {
  test('connect → listTools returns descriptors with defaults filled in', async () => {
    const { fake } = makeFakeSdkClient({
      tools: [
        { name: 'list_issues', description: 'list', inputSchema: { type: 'object' } },
        { name: 'no_schema' }, // missing description + inputSchema
      ],
    })
    const client = new MCPClient(server, { client: fake })
    const tools = await client.listTools()
    expect(tools).toEqual([
      { name: 'list_issues', description: 'list', inputSchema: { type: 'object' } },
      { name: 'no_schema', description: '', inputSchema: { type: 'object' } },
    ])
  })

  test('callTool — flattens text blocks; reports isError', async () => {
    const { fake } = makeFakeSdkClient({
      callResponses: {
        echo: {
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
          ],
        },
        broken: {
          content: [{ type: 'text', text: 'kaboom' }],
          isError: true,
        },
      },
    })
    const client = new MCPClient(server, { client: fake })
    const ok = await client.callTool('echo', { x: 1 })
    expect(ok).toEqual({ content: 'hello world', isError: false })
    const err = await client.callTool('broken', {})
    expect(err).toEqual({ content: 'kaboom', isError: true })
  })

  test('connect failure wraps as BrainError with cause preserved', async () => {
    const cause = new Error('network down')
    const { fake } = makeFakeSdkClient({ connectThrows: cause })
    const client = new MCPClient(server, { client: fake })
    let thrown: unknown
    try {
      await client.listTools()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).cause).toBe(cause)
  })

  test('connect runs only once across multiple calls', async () => {
    const { fake, connectCalls } = makeFakeSdkClient({
      tools: [{ name: 't' }],
      callResponses: { t: { content: [{ type: 'text', text: 'ok' }] } },
    })
    const client = new MCPClient(server, { client: fake })
    await client.listTools()
    await client.callTool('t', {})
    expect(connectCalls).toHaveLength(1)
  })

  test('close is idempotent and resets the connected flag', async () => {
    const { fake, isClosed } = makeFakeSdkClient({ tools: [] })
    const client = new MCPClient(server, { client: fake })
    await client.connect()
    await client.close()
    await client.close()
    expect(isClosed()).toBe(true)
  })
})

describe('resolveMcpTools', () => {
  test('namespaces tool names as <server>__<tool>', async () => {
    const { fake } = makeFakeSdkClient({
      tools: [{ name: 'list_issues' }, { name: 'create_issue' }],
      callResponses: { list_issues: { content: [{ type: 'text', text: 'rows' }] } },
    })
    const client = new MCPClient(server, { client: fake })
    const resolved = await resolveMcpTools([server], { clientFactory: () => client })
    expect(resolved.tools.map((t) => t.name)).toEqual([
      'linear__list_issues',
      'linear__create_issue',
    ])
    // execute routes back to the underlying name
    const out = await resolved.tools[0]!.execute({}, { callId: 'c', context: {} })
    expect(out).toBe('rows')
    await resolved.close()
  })

  test('respects allowedTools whitelist', async () => {
    const { fake } = makeFakeSdkClient({
      tools: [{ name: 'list_issues' }, { name: 'create_issue' }, { name: 'delete_issue' }],
    })
    const client = new MCPClient(server, { client: fake })
    const filtered: MCPServer = {
      ...server,
      tools: { allowedTools: ['list_issues'] },
    }
    const resolved = await resolveMcpTools([filtered], { clientFactory: () => client })
    expect(resolved.tools.map((t) => t.name)).toEqual(['linear__list_issues'])
    await resolved.close()
  })

  test('skips servers with enabled: false', async () => {
    let factoryCalls = 0
    const factory = () => {
      factoryCalls++
      const { fake } = makeFakeSdkClient({ tools: [{ name: 't' }] })
      return new MCPClient(server, { client: fake })
    }
    const disabled: MCPServer = { ...server, tools: { enabled: false } }
    const resolved = await resolveMcpTools([disabled], { clientFactory: factory })
    expect(resolved.tools).toEqual([])
    expect(factoryCalls).toBe(0)
    await resolved.close()
  })

  test('execute surfaces MCP-reported errors as a stringified message', async () => {
    const { fake } = makeFakeSdkClient({
      tools: [{ name: 'broken' }],
      callResponses: {
        broken: { content: [{ type: 'text', text: 'tool failed' }], isError: true },
      },
    })
    const client = new MCPClient(server, { client: fake })
    const resolved = await resolveMcpTools([server], { clientFactory: () => client })
    const out = await resolved.tools[0]!.execute({}, { callId: 'c', context: {} })
    expect(out).toBe('MCP tool error: tool failed')
    await resolved.close()
  })
})
