// Public API of `@strav/brain/mcp` — local MCP client for providers
// without server-side MCP support (OpenAI, Gemini, DeepSeek). The
// Anthropic provider continues to use server-side MCP via the
// top-level `MCPServer` config; nothing here is needed for that path.

export {
  MCPClient,
  type MCPCallToolResult,
  type MCPClientOptions,
  type MCPToolDescriptor,
} from './client.ts'
export {
  MCPAuthRequiredError,
  type MCPOAuthConfig,
  type MCPOAuthStore,
  MemoryOAuthStore,
} from './oauth.ts'
export { MCPClientPool, type MCPClientFactory } from './pool.ts'
export {
  resolveMcpTools,
  type ResolveMcpToolsOptions,
  type ResolvedMcpTools,
} from './resolve_mcp_tools.ts'
