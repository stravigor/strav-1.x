/**
 * `resolveMcpTools` — connects to each `MCPServer`, discovers its
 * tools, and surfaces them as framework `Tool`s the standard agentic
 * loop already knows how to invoke.
 *
 * Honors the per-server config in `MCPServer.tools`:
 *   - `enabled: false` → server is skipped entirely.
 *   - `allowedTools` → only those tool names are exposed.
 *
 * Naming: discovered tools are namespaced as `<server>__<tool>` to
 * keep names unique when multiple servers expose overlapping names.
 * The `Tool.execute` then routes back to the correct server. The
 * underscore separator (not `.` or `/`) is chosen because OpenAI's
 * tool-name regex rejects `.` and `/`.
 *
 * Lifecycle: this helper returns `{ tools, close }`. `close` runs all
 * client `close()` calls in parallel — providers must call it in a
 * `finally` to avoid leaking transports.
 */

import type { MCPServer } from '../mcp_server.ts'
import type { Tool, ToolContext } from '../tool.ts'
import { MCPClient } from './client.ts'
import type { MCPClientPool } from './pool.ts'

export interface ResolvedMcpTools {
  tools: Tool[]
  close(): Promise<void>
}

export interface ResolveMcpToolsOptions {
  /** Override the client factory — tests inject mock clients per server here. */
  clientFactory?(server: MCPServer): MCPClient
  /**
   * When set, clients are borrowed from the pool instead of being
   * constructed fresh per call, and the returned `close` becomes a
   * no-op — the pool owns the lifetime, and apps call
   * `pool.close()` on shutdown. Mutually beneficial with
   * `clientFactory` (tests pass a factory to the pool itself).
   */
  pool?: MCPClientPool
}

const NAME_SEPARATOR = '__'

export async function resolveMcpTools(
  servers: readonly MCPServer[],
  options: ResolveMcpToolsOptions = {},
): Promise<ResolvedMcpTools> {
  const clients: MCPClient[] = []
  const tools: Tool[] = []
  const pooled = options.pool !== undefined

  for (const server of servers) {
    if (server.tools?.enabled === false) continue
    const client = options.pool
      ? options.pool.borrow(server)
      : options.clientFactory
        ? options.clientFactory(server)
        : new MCPClient(server)
    if (!pooled) clients.push(client)

    const allowed = server.tools?.allowedTools
    const allowedSet = allowed ? new Set(allowed) : null

    const descriptors = await client.listTools()
    for (const descriptor of descriptors) {
      if (allowedSet && !allowedSet.has(descriptor.name)) continue
      tools.push(buildTool(server.name, client, descriptor))
    }
  }

  return {
    tools,
    // Pooled clients live across calls — `close` becomes a no-op
    // and the pool owns the lifetime. Non-pooled clients close
    // here so each `runWithTools` invocation cleans up its own
    // transports.
    close: pooled
      ? async () => {}
      : async () => {
          await Promise.all(clients.map((c) => c.close()))
        },
  }
}

function buildTool(
  serverName: string,
  client: MCPClient,
  descriptor: { name: string; description: string; inputSchema: Record<string, unknown> },
): Tool {
  return {
    name: `${serverName}${NAME_SEPARATOR}${descriptor.name}`,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    async execute(input: unknown, ctx: ToolContext): Promise<string> {
      const result = await client.callTool(
        descriptor.name,
        input,
        ctx.signal !== undefined ? { signal: ctx.signal } : {},
      )
      if (result.isError) {
        return `MCP tool error: ${result.content}`
      }
      return result.content
    },
  }
}
