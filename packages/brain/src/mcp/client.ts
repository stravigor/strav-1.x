/**
 * `MCPClient` — local MCP client for providers that lack server-side
 * MCP support (OpenAI, Gemini, DeepSeek, …).
 *
 * Wraps the official `@modelcontextprotocol/sdk` client. Connects to a
 * single MCP server over Streamable HTTP, lists its tools, and invokes
 * them. The agentic loop sees these as ordinary `Tool`s — translation
 * happens in `resolveMcpTools`.
 *
 * Lifecycle:
 *
 *   const client = new MCPClient(serverConfig)
 *   await client.connect()
 *   const tools = await client.listTools()
 *   const result = await client.callTool('name', {...})
 *   await client.close()
 *
 * Authentication:
 *   - `MCPServer.authorizationToken` → static bearer; fine for
 *     self-hosted servers where the app controls the token.
 *   - `MCPServer.oauth` → drives the authorization-code-with-PKCE
 *     flow against the server's OAuth endpoints. On
 *     `connect()` against an un-authorized server,
 *     `MCPAuthRequiredError` is thrown carrying the URL the user
 *     should be redirected to. After the user authorizes and is
 *     redirected back, the app's callback handler calls
 *     `completeAuthorization(code)` to finish the exchange.
 *   The two are mutually exclusive — passing both throws.
 *
 * Transport:
 *   V1 only does Streamable HTTP — the current MCP transport. Legacy
 *   SSE-only endpoints aren't supported; if a server URL ends with
 *   `/sse` and only speaks the legacy protocol, the connection will
 *   fail and apps should run against a Streamable-HTTP endpoint
 *   instead.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { BrainError } from '../brain_error.ts'
import type { MCPServer } from '../mcp_server.ts'
import { MCPAuthRequiredError, StoreBackedOAuthProvider } from './oauth.ts'

/** Result of a single MCP tool invocation, as returned by `tools/call`. */
export interface MCPCallToolResult {
  /** Stringified content — text blocks concatenated; image / resource blocks JSON-serialized. */
  content: string
  /** `true` when the MCP server reports the tool execution failed. */
  isError: boolean
}

/** Tool descriptor surfaced by `tools/list`. */
export interface MCPToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPClientOptions {
  /** Override the transport used to dial the server. Tests inject a mock here. */
  client?: Client
}

export class MCPClient {
  readonly server: MCPServer
  private readonly _client: Client
  private _connected = false
  private _transport: StreamableHTTPClientTransport | undefined
  private _authProvider: StoreBackedOAuthProvider | undefined

  constructor(server: MCPServer, options: MCPClientOptions = {}) {
    if (server.authorizationToken !== undefined && server.oauth !== undefined) {
      throw new BrainError(
        `MCPClient(${server.name}): \`authorizationToken\` and \`oauth\` are mutually exclusive — set one.`,
        { context: { server: server.name } },
      )
    }
    this.server = server
    this._client =
      options.client ??
      new Client(
        { name: `@strav/brain:${server.name}`, version: '1.0.0' },
        { capabilities: {} },
      )
  }

  async connect(): Promise<void> {
    if (this._connected) return
    const transport = this._buildTransport()
    this._transport = transport
    try {
      await this._client.connect(transport)
      this._connected = true
    } catch (cause) {
      if (cause instanceof UnauthorizedError && this._authProvider?.capturedAuthorizationUrl) {
        throw new MCPAuthRequiredError(
          this.server.name,
          this._authProvider.capturedAuthorizationUrl.toString(),
        )
      }
      throw new BrainError(
        `MCPClient(${this.server.name}): failed to connect to ${this.server.url}.`,
        { context: { server: this.server.name, url: this.server.url }, cause },
      )
    }
  }

  /**
   * Finish the OAuth authorization-code flow after the user
   * authorized and was redirected back to the app's callback URL.
   * Exchanges `code` for tokens, persists them via the configured
   * `MCPOAuthStore`, then connects.
   *
   * Throws `BrainError` when called on a server without OAuth
   * configured.
   */
  async completeAuthorization(code: string): Promise<void> {
    if (this.server.oauth === undefined) {
      throw new BrainError(
        `MCPClient(${this.server.name}): completeAuthorization() called on a server without \`oauth\` configured.`,
        { context: { server: this.server.name } },
      )
    }
    if (this._transport === undefined) {
      // A previous `connect()` attempt builds the transport + captures
      // the auth URL on the provider. Apps that lost the transport
      // reference (typical for stateless callback handlers) can
      // construct a fresh transport here — the store carries every
      // bit of state the exchange needs.
      this._transport = this._buildTransport()
    }
    await this._transport.finishAuth(code)
    // Now that tokens are saved, re-attempt the connection.
    this._connected = false
    await this.connect()
  }

  async listTools(opts: { signal?: AbortSignal } = {}): Promise<MCPToolDescriptor[]> {
    await this.connect()
    let response: Awaited<ReturnType<Client['listTools']>>
    try {
      response = await this._client.listTools(
        undefined,
        opts.signal !== undefined ? { signal: opts.signal } : undefined,
      )
    } catch (cause) {
      throw new BrainError(
        `MCPClient(${this.server.name}): tools/list failed.`,
        { context: { server: this.server.name }, cause },
      )
    }
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }))
  }

  async callTool(
    name: string,
    input: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<MCPCallToolResult> {
    await this.connect()
    let response: Awaited<ReturnType<Client['callTool']>>
    try {
      response = await this._client.callTool(
        {
          name,
          arguments: (input ?? {}) as Record<string, unknown>,
        },
        undefined,
        opts.signal !== undefined ? { signal: opts.signal } : undefined,
      )
    } catch (cause) {
      throw new BrainError(
        `MCPClient(${this.server.name}): tools/call ${name} failed.`,
        { context: { server: this.server.name, tool: name }, cause },
      )
    }
    return {
      content: flattenContent(response.content),
      isError: Boolean(response.isError),
    }
  }

  async close(): Promise<void> {
    if (!this._connected) return
    try {
      await this._client.close()
    } finally {
      this._connected = false
    }
  }

  private _buildTransport(): StreamableHTTPClientTransport {
    const headers: Record<string, string> = {}
    if (this.server.authorizationToken !== undefined) {
      headers.Authorization = `Bearer ${this.server.authorizationToken}`
    }
    const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
      requestInit: { headers },
    }
    if (this.server.oauth !== undefined) {
      this._authProvider = new StoreBackedOAuthProvider(this.server.oauth)
      transportOpts.authProvider = this._authProvider
    }
    return new StreamableHTTPClientTransport(new URL(this.server.url), transportOpts)
  }
}

function flattenContent(
  content: Awaited<ReturnType<Client['callTool']>>['content'],
): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('')
}
