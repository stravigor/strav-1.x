/**
 * MCP OAuth tests — verifies `MemoryOAuthStore` is round-trippable
 * and that `MCPClient.connect()` surfaces an `MCPAuthRequiredError`
 * carrying the authorization URL, then `completeAuthorization`
 * finishes the exchange via the SDK transport.
 */

import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { BrainError } from '../src/brain_error.ts'
import { MCPClient } from '../src/mcp/client.ts'
import {
  MCPAuthRequiredError,
  MemoryOAuthStore,
  type MCPOAuthConfig,
} from '../src/mcp/oauth.ts'
import type { MCPServer } from '../src/mcp_server.ts'

// ─── MemoryOAuthStore ────────────────────────────────────────────────────

describe('MemoryOAuthStore', () => {
  test('round-trips client info / tokens / code verifier', async () => {
    const store = new MemoryOAuthStore()
    expect(await store.clientInformation()).toBeUndefined()
    expect(await store.tokens()).toBeUndefined()

    const info: OAuthClientInformationFull = {
      client_id: 'cid',
      client_secret: 'sec',
      redirect_uris: ['https://app.example.com/cb'],
    } as unknown as OAuthClientInformationFull
    await store.saveClientInformation(info)
    expect(await store.clientInformation()).toBe(info)

    const tokens: OAuthTokens = {
      access_token: 'at',
      token_type: 'bearer',
      refresh_token: 'rt',
    } as OAuthTokens
    await store.saveTokens(tokens)
    expect(await store.tokens()).toBe(tokens)

    await store.saveCodeVerifier('v123')
    expect(await store.codeVerifier()).toBe('v123')
  })

  test('codeVerifier throws BrainError when none saved', () => {
    const store = new MemoryOAuthStore()
    expect(() => store.codeVerifier()).toThrow(BrainError)
  })
})

// ─── MCPClient OAuth flow ────────────────────────────────────────────────

describe('MCPClient — OAuth flow', () => {
  test('mutually exclusive: authorizationToken + oauth throws at construction', () => {
    const store = new MemoryOAuthStore()
    const server: MCPServer = {
      name: 's',
      url: 'https://mcp.example.com',
      authorizationToken: 'bearer-x',
      oauth: { redirectUri: 'https://app.example.com/cb', store } satisfies MCPOAuthConfig,
    }
    expect(() => new MCPClient(server)).toThrow(BrainError)
  })

  test('connect → MCPAuthRequiredError carrying the captured auth URL', async () => {
    const store = new MemoryOAuthStore()
    const server: MCPServer = {
      name: 'linear',
      url: 'https://mcp.linear.app',
      oauth: { redirectUri: 'https://app.example.com/cb', store },
    }
    // Fake SDK client that, on connect(), accepts the transport,
    // synchronously triggers the authProvider's redirect hook (as
    // the real SDK does during the unauthorized handshake), then
    // throws UnauthorizedError.
    const fakeClient = {
      async connect(transport: unknown) {
        const ap = (transport as { _authProvider?: { redirectToAuthorization?: (u: URL) => void } })._authProvider
        await ap?.redirectToAuthorization?.(new URL('https://auth.linear.app/oauth/authorize?...'))
        throw new UnauthorizedError('please authorize')
      },
      async close() {},
    } as unknown as Client
    const client = new MCPClient(server, { client: fakeClient })
    let thrown: unknown
    try {
      await client.connect()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MCPAuthRequiredError)
    expect((thrown as MCPAuthRequiredError).authorizationUrl).toBe(
      'https://auth.linear.app/oauth/authorize?...',
    )
    expect((thrown as MCPAuthRequiredError).context.server).toBe('linear')
  })

  test('completeAuthorization without oauth config throws', async () => {
    const server: MCPServer = { name: 's', url: 'https://mcp.example.com' }
    const fakeClient = {
      async connect() {},
      async close() {},
    } as unknown as Client
    const client = new MCPClient(server, { client: fakeClient })
    await expect(client.completeAuthorization('code')).rejects.toBeInstanceOf(BrainError)
  })

  test('completeAuthorization → calls transport.finishAuth then connects', async () => {
    const store = new MemoryOAuthStore()
    const server: MCPServer = {
      name: 'linear',
      url: 'https://mcp.linear.app',
      oauth: { redirectUri: 'https://app.example.com/cb', store },
    }
    // After completeAuthorization, the next connect() should succeed.
    let connectCalls = 0
    const fakeClient = {
      async connect(transport: unknown) {
        connectCalls++
        if (connectCalls === 1) {
          const ap = (transport as { _authProvider?: { redirectToAuthorization?: (u: URL) => void } })._authProvider
          await ap?.redirectToAuthorization?.(new URL('https://auth.linear.app/x'))
          throw new UnauthorizedError('please authorize')
        }
        // Second connect (post completeAuthorization) just succeeds.
      },
      async close() {},
    } as unknown as Client
    const client = new MCPClient(server, { client: fakeClient })

    // First connect throws auth-required.
    let firstThrew: unknown
    try {
      await client.connect()
    } catch (e) {
      firstThrew = e
    }
    expect(firstThrew).toBeInstanceOf(MCPAuthRequiredError)

    // Stub finishAuth on the existing transport so the test doesn't
    // dial the network. The transport instance hangs off the client
    // — overwrite finishAuth on its prototype-less object.
    const transport = (client as unknown as { _transport: { finishAuth: (code: string) => Promise<void> } })._transport
    let finishedWith: string | undefined
    transport.finishAuth = async (code: string) => { finishedWith = code }

    await client.completeAuthorization('the-code')
    expect(finishedWith).toBe('the-code')
    expect(connectCalls).toBe(2)
  })
})
