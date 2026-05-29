/**
 * `MCPServer` — declarative configuration for a remote MCP server
 * that Anthropic's backend invokes on behalf of the model.
 *
 * V1 leverages Anthropic's server-side MCP support: apps declare
 * server URLs (with optional bearer auth) on the request; the
 * backend connects to them, discovers their tools, surfaces them to
 * the model, and runs the tool calls itself. The agentic loop here
 * doesn't intercept MCP tool calls — they appear in the response as
 * `MCPToolUseBlock` / `MCPToolResultBlock` content blocks for
 * observability and audit-trail rendering.
 *
 * For OpenAI / Gemini / DeepSeek providers (later slices), a local
 * MCP client implementation will live alongside this to translate
 * MCP-discovered tools into `Tool` records and let the framework run
 * the loop. The V1 contract stays the same; the per-provider
 * implementation differs.
 *
 * `allowedTools` opts into a subset of the server's exposed tools —
 * useful for narrowing surface area when the MCP server exposes more
 * capabilities than the agent should be able to invoke. `enabled`
 * defaults to `true`; set to `false` to declare the server without
 * routing model calls to it (rare, but handy for temporary
 * disablement without re-deploying config).
 */

export interface MCPServerToolConfig {
  /** Whitelist of tool names the agent can call. Omit for "all tools the server exposes." */
  allowedTools?: readonly string[]
  /** Default `true`. Set `false` to declare-but-disable. */
  enabled?: boolean
}

export interface MCPServer {
  /** Server identifier — used in MCPToolUseBlock.serverName + logging. */
  name: string
  /** HTTPS URL of the MCP server. */
  url: string
  /**
   * Optional bearer token. Apps source from env vars / secrets
   * managers — never hardcode. The framework forwards this verbatim
   * to the provider's `authorization_token` field.
   *
   * Mutually exclusive with `oauth`. Use `authorizationToken` for
   * self-hosted servers where you control the token; use `oauth`
   * for commercial servers (Linear, Notion, GitHub, ...).
   */
  authorizationToken?: string
  /**
   * OAuth configuration for servers that require it. When set, the
   * local MCP client (`@strav/brain/mcp`) drives the
   * authorization-code-with-PKCE flow against the server's OAuth
   * endpoints, storing tokens via the supplied `store`. The
   * Anthropic server-side path doesn't use this — Anthropic's
   * connector handles its own auth.
   *
   * Mutually exclusive with `authorizationToken`. See the OAuth
   * section of `docs/brain/guides/mcp.md`.
   */
  oauth?: import('./mcp/oauth.ts').MCPOAuthConfig
  /** Per-server tool config (allowlist / enable flag). */
  tools?: MCPServerToolConfig
}
