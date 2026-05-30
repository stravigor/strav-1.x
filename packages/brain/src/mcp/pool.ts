/**
 * `MCPClientPool` — long-lived, per-server `MCPClient` cache.
 *
 * Default `resolveMcpTools` flow constructs a fresh `MCPClient` per
 * call to `runTools` / `runWithTools` / etc., handshakes the
 * Streamable HTTP transport, lists tools, executes them, then
 * closes the transport in a `finally`. For one-shot calls that's
 * fine. For long-running agent workers — chat servers, background
 * job processors — the per-call handshake adds noticeable
 * latency and burns connection slots upstream.
 *
 * The pool keeps one connected `MCPClient` per `(server.name,
 * server.url)` pair for the lifetime of the pool. `borrow(server)`
 * returns the pooled client (lazily creating + connecting on
 * first use). When the pool is in play, `resolveMcpTools` skips
 * the per-call `close()` — the pool owns the lifetime — so
 * subsequent calls reuse the existing transport.
 *
 * Apps own the pool's lifetime. Construct one at app boot, hand it
 * to every provider (or to `BrainProvider` if using the DI
 * helper), and call `pool.close()` on shutdown.
 *
 * ```ts
 * const pool = new MCPClientPool()
 *
 * const openai = new OpenAIBrainDriver(
 *   'openai',
 *   { driver: 'openai', apiKey: ... },
 *   { mcpPool: pool },
 * )
 *
 * // ... many runTools calls later, on graceful shutdown:
 * await pool.close()
 * ```
 *
 * Concurrency: `borrow()` is synchronous; `MCPClient.connect()`
 * itself dedupes concurrent calls. Two parallel `runTools` calls
 * sharing the same pooled client both await one handshake.
 *
 * Re-auth: when a borrowed client throws `MCPAuthRequiredError`,
 * the pool keeps the (still un-authorized) client. Apps call
 * `pool.evict(server)` after running `completeAuthorization` on
 * a fresh client so subsequent borrows see the renewed state —
 * or just reuse the same client the app authorized via the
 * standard `MCPClient.completeAuthorization` flow.
 */

import type { MCPServer } from '../mcp_server.ts'
import { MCPClient } from './client.ts'

/** Internal — factory injection for tests. Defaults to `new MCPClient(server)`. */
export type MCPClientFactory = (server: MCPServer) => MCPClient

export class MCPClientPool {
  private readonly clients: Map<string, MCPClient> = new Map()
  private readonly factory: MCPClientFactory

  constructor(factory: MCPClientFactory = (s) => new MCPClient(s)) {
    this.factory = factory
  }

  /**
   * Return the pooled client for `server`, constructing + caching it on
   * first call. The client is NOT eagerly connected — the first
   * `listTools` / `callTool` invocation triggers `connect()` once.
   */
  borrow(server: MCPServer): MCPClient {
    const key = poolKey(server)
    const existing = this.clients.get(key)
    if (existing) return existing
    const client = this.factory(server)
    this.clients.set(key, client)
    return client
  }

  /**
   * Drop the cached client for `server` and close its transport.
   * Useful after the app re-authorizes an OAuth server, or after a
   * transient failure where the connection state is suspect and a
   * fresh handshake on next borrow is preferable.
   */
  async evict(server: MCPServer): Promise<void> {
    const key = poolKey(server)
    const client = this.clients.get(key)
    if (!client) return
    this.clients.delete(key)
    await client.close()
  }

  /** Close every pooled client. Call on app shutdown. */
  async close(): Promise<void> {
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map((c) => c.close()))
  }

  /** Whether the pool currently holds a client for `server`. Used by tests. */
  has(server: MCPServer): boolean {
    return this.clients.has(poolKey(server))
  }
}

/** Pool key: name + url, so two `MCPServer`s with the same name but different URLs don't collide. */
function poolKey(server: MCPServer): string {
  return `${server.name}|${server.url}`
}
