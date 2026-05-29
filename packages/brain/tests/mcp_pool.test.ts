/**
 * `MCPClientPool` + `resolveMcpTools(pool)` integration tests. Stubs
 * `MCPClient` via the pool's `factory` so no transport is dialed.
 */

import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { MCPClient } from '../src/mcp/client.ts'
import { MCPClientPool } from '../src/mcp/pool.ts'
import { resolveMcpTools } from '../src/mcp/resolve_mcp_tools.ts'
import type { MCPServer } from '../src/mcp_server.ts'

function makeFakeSdkClient(opts: {
  tools?: Array<{ name: string }>
  connectDelay?: number
}) {
  let connectCount = 0
  let closeCount = 0
  const fake = {
    async connect() {
      connectCount++
      if (opts.connectDelay) await new Promise((r) => setTimeout(r, opts.connectDelay))
    },
    async listTools() {
      return {
        tools: (opts.tools ?? []).map((t) => ({
          name: t.name,
          description: '',
          inputSchema: { type: 'object' },
        })),
      }
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }], isError: false }
    },
    async close() {
      closeCount++
    },
  } as unknown as Client
  return {
    fake,
    getConnectCount: () => connectCount,
    getCloseCount: () => closeCount,
  }
}

const linear: MCPServer = {
  name: 'linear',
  url: 'https://mcp.linear.app',
  authorizationToken: 't1',
}

const stripe: MCPServer = {
  name: 'stripe',
  url: 'https://mcp.stripe.com',
  authorizationToken: 't2',
}

// ─── MCPClientPool — borrow + caching ───────────────────────────────────

describe('MCPClientPool', () => {
  test('borrow returns the same client across calls for the same server', () => {
    const { fake } = makeFakeSdkClient({ tools: [{ name: 't' }] })
    const pool = new MCPClientPool((s) => new MCPClient(s, { client: fake }))
    const a = pool.borrow(linear)
    const b = pool.borrow(linear)
    expect(a).toBe(b)
  })

  test('different servers get distinct clients', () => {
    const { fake } = makeFakeSdkClient({})
    const pool = new MCPClientPool((s) => new MCPClient(s, { client: fake }))
    const a = pool.borrow(linear)
    const b = pool.borrow(stripe)
    expect(a).not.toBe(b)
    expect(pool.has(linear)).toBe(true)
    expect(pool.has(stripe)).toBe(true)
  })

  test('close() closes every pooled client and clears the cache', async () => {
    const linearFake = makeFakeSdkClient({})
    const stripeFake = makeFakeSdkClient({})
    let i = 0
    const pool = new MCPClientPool((s) => {
      const fake = i++ === 0 ? linearFake.fake : stripeFake.fake
      return new MCPClient(s, { client: fake })
    })
    const linearClient = pool.borrow(linear)
    const stripeClient = pool.borrow(stripe)
    await linearClient.connect()
    await stripeClient.connect()
    await pool.close()
    expect(linearFake.getCloseCount()).toBe(1)
    expect(stripeFake.getCloseCount()).toBe(1)
    expect(pool.has(linear)).toBe(false)
    expect(pool.has(stripe)).toBe(false)
  })

  test('evict closes only the targeted client', async () => {
    const { fake, getCloseCount } = makeFakeSdkClient({})
    const pool = new MCPClientPool((s) => new MCPClient(s, { client: fake }))
    const client = pool.borrow(linear)
    await client.connect()
    await pool.evict(linear)
    expect(getCloseCount()).toBe(1)
    expect(pool.has(linear)).toBe(false)
  })
})

// ─── MCPClient — concurrent connect dedupe ──────────────────────────────

describe('MCPClient — concurrent connect()', () => {
  test('parallel connect calls share one transport handshake', async () => {
    const { fake, getConnectCount } = makeFakeSdkClient({ connectDelay: 20 })
    const client = new MCPClient(linear, { client: fake })
    await Promise.all([client.connect(), client.connect(), client.connect()])
    expect(getConnectCount()).toBe(1)
  })

  test('subsequent connect after settling is a no-op', async () => {
    const { fake, getConnectCount } = makeFakeSdkClient({})
    const client = new MCPClient(linear, { client: fake })
    await client.connect()
    await client.connect()
    expect(getConnectCount()).toBe(1)
  })
})

// ─── resolveMcpTools(pool) — connection reuse + no-op close ─────────────

describe('resolveMcpTools — pool integration', () => {
  test('two resolveMcpTools calls with the same pool share one handshake per server', async () => {
    const { fake, getConnectCount } = makeFakeSdkClient({ tools: [{ name: 'list' }] })
    const pool = new MCPClientPool((s) => new MCPClient(s, { client: fake }))

    const r1 = await resolveMcpTools([linear], { pool })
    await r1.close()
    const r2 = await resolveMcpTools([linear], { pool })
    await r2.close()

    expect(getConnectCount()).toBe(1)
    expect(r1.tools.map((t) => t.name)).toEqual(['linear__list'])
  })

  test('pooled close is a no-op — the pool owns the lifetime', async () => {
    const { fake, getCloseCount } = makeFakeSdkClient({ tools: [{ name: 'list' }] })
    const pool = new MCPClientPool((s) => new MCPClient(s, { client: fake }))

    const r = await resolveMcpTools([linear], { pool })
    await r.close()
    expect(getCloseCount()).toBe(0)

    // Pool.close() is the one that actually shuts things down.
    await pool.close()
    expect(getCloseCount()).toBe(1)
  })

  test('without a pool, resolveMcpTools closes the client in r.close()', async () => {
    const { fake, getCloseCount } = makeFakeSdkClient({ tools: [{ name: 'list' }] })
    const r = await resolveMcpTools([linear], {
      clientFactory: (s) => new MCPClient(s, { client: fake }),
    })
    expect(getCloseCount()).toBe(0)
    await r.close()
    expect(getCloseCount()).toBe(1)
  })
})
