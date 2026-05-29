# MCP — Model Context Protocol

MCP (Model Context Protocol) is the open standard for exposing tools to LLMs. The Anthropic ecosystem has growing first-party MCP server support — Linear, Notion, GitHub, Asana, and more publish hosted MCP endpoints you can connect to.

`@strav/brain` V1 supports MCP via **Anthropic's server-side connector**: you declare the MCP servers on your agent or per call, and Anthropic's backend handles the OAuth flow, tool discovery, and tool invocation. The model treats MCP-exposed tools the same as locally-defined `Tool`s; your code just sees the `mcp_tool_use` / `mcp_tool_result` blocks land in `result.messages` for observability.

This guide covers:

- How to declare MCP servers (app-level, agent-level, per-call)
- What configuration options each server supports
- How MCP and locally-defined tools coexist
- How to render MCP usage in app UIs
- What's deferred for V2

## Declaring MCP servers

Three places, in increasing specificity:

### 1. App-level default in `config.brain`

Use when every agent in the app talks to the same MCP servers:

```ts
// config/brain.ts
import { env } from '@strav/kernel'
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'anthropic',
  providers: {
    anthropic: {
      driver: 'anthropic',
      apiKey: env('ANTHROPIC_API_KEY'),
      defaultModel: 'claude-opus-4-7',
    },
  },
  mcpServers: [
    { name: 'linear',  url: 'https://mcp.linear.app/sse',  authorizationToken: env('LINEAR_MCP_TOKEN') },
    { name: 'notion',  url: 'https://mcp.notion.com/sse',  authorizationToken: env('NOTION_MCP_TOKEN') },
  ],
} satisfies BrainConfigShape
```

`BrainManager.runTools` will use this list whenever the call site doesn't pass its own `mcpServers`.

### 2. Per-agent via `Agent.mcpServers`

Use when a specific agent needs servers others don't:

```ts
@inject()
class TicketTriageAgent extends Agent {
  override readonly instructions = 'You triage incoming support tickets...'
  override readonly tools = [knowledgeBaseSearchTool]
  override readonly mcpServers = [
    { name: 'linear', url: 'https://mcp.linear.app/sse', authorizationToken: env('LINEAR_MCP_TOKEN') },
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/', authorizationToken: env('GITHUB_TOKEN') },
  ]
}
```

The agent's servers replace any `config.brain.mcpServers` for that call.

### 3. Per-call via `RunWithToolsOptions.mcpServers`

Use when the server list is dynamic — different users have different MCP credentials, for example:

```ts
const result = await brain.runTools(
  'Summarize my open Linear issues.',
  [],
  {
    mcpServers: [
      { name: 'linear', url: 'https://mcp.linear.app/sse', authorizationToken: ctx.auth.user.linearToken },
    ],
  },
)
```

**Per-call replaces, doesn't merge.** Passing `mcpServers: []` explicitly opts out — the call sees no MCP servers regardless of the app-level default. Apps that want additive behavior construct the merged list themselves.

## `MCPServer` configuration

```ts
interface MCPServer {
  name: string                        // identifier — matches MCPToolUseBlock.serverName
  url: string                          // HTTPS URL of the MCP server
  authorizationToken?: string          // optional bearer token (sourced from env / secrets)
  tools?: MCPServerToolConfig          // per-server tool config
}

interface MCPServerToolConfig {
  allowedTools?: readonly string[]     // whitelist of tool names; omit = all
  enabled?: boolean                    // default true; false declares-but-disables
}
```

**`allowedTools`** lets you narrow a server's surface area. The Linear MCP server might expose `list_issues`, `create_issue`, `add_comment`, etc. — if an agent should only *read*, set `tools: { allowedTools: ['list_issues', 'list_projects'] }` and the model won't see the write tools.

**`enabled: false`** declares the server (so it appears in `mcp_servers` on the wire) but doesn't route any tool calls through it. Useful for temporary disablement — e.g., during a Linear MCP outage — without re-deploying config.

**`authorizationToken`** is a bearer token sent in `Authorization: Bearer <token>` headers when Anthropic's connector calls the MCP server. Source it from env vars or a secrets manager; never hardcode. For OAuth-flow MCP servers, you'll need to handle the OAuth handshake out-of-band and feed the resulting access token here.

## MCP and local tools coexist

You can declare both `tools` (locally-defined via `defineTool`) and `mcpServers` on the same call:

```ts
const result = await brain.runTools(
  'Look up issue STR-42 in Linear, then send a summary to #engineering.',
  [postToSlack],         // local tool
  {
    mcpServers: [linearMcp],
  },
)
```

The model sees:
- `post_to_slack` — your local tool (you handle invocation)
- Whatever tools Linear's MCP server exposes — Anthropic handles invocation

Agentic loop behavior:
- Local tools: the runner detects `tool_use`, calls `execute`, appends `tool_result`, re-asks.
- MCP tools: Anthropic's backend handles the entire round-trip — the response carries `mcp_tool_use` and `mcp_tool_result` blocks inline (already complete) and the model continues its reasoning in the same turn.

So MCP "doesn't cost an iteration" — the loop doesn't round-trip your process for MCP tools.

## Reading MCP usage from the result

MCP blocks appear in `result.messages` for observability. Apps that want to render which MCP tools the agent consulted iterate over them:

```ts
const result = await brain.agent(ResearchAgent).input('What does Linear say?').run()

for (const message of result.messages) {
  if (message.role !== 'assistant' || typeof message.content === 'string') continue
  for (const block of message.content) {
    if (block.type === 'mcp_tool_use') {
      console.log(`Agent called ${block.serverName}.${block.name} with input:`, block.input)
    } else if (block.type === 'mcp_tool_result') {
      console.log(`Got result for ${block.toolUseId}:`, block.content)
    }
  }
}
```

The shapes:

```ts
interface MCPToolUseBlock {
  type: 'mcp_tool_use'
  id: string
  serverName: string    // matches MCPServer.name
  name: string          // tool name as exposed by the MCP server
  input: unknown        // parsed JSON the model sent
}

interface MCPToolResultBlock {
  type: 'mcp_tool_result'
  toolUseId: string     // matches MCPToolUseBlock.id
  content: string | TextBlock[]
  isError?: boolean     // true when the MCP server returned an error
}
```

These are **read-only**. The framework never echoes them back to the model — Anthropic's backend tracks MCP tool state on its side. The `toMessageParam` translator filters them out when constructing the next request.

## When the MCP server fails

When the MCP server returns an error, the `mcp_tool_result` block has `isError: true` and the `content` carries the error message. The model sees this and adapts — typically by asking the user for clarification or trying a different approach.

You'll also see `session.error`-style events if the MCP server is unreachable entirely. V1 surfaces these as part of the assistant turn; apps that want to alert on MCP outages inspect `result.messages` for `isError: true` blocks.

## Beta header

When `mcpServers` is non-empty, the provider switches from `client.messages.create` to `client.beta.messages.create` and adds the `mcp-client-2025-11-20` beta header automatically. Apps don't need to manage this — it's part of the provider's translation.

## What's deferred for V2

- **OpenAI / Gemini / DeepSeek providers** — each will need its own MCP implementation. Anthropic ships first-party server-side MCP; for providers without that, V2 will add a local MCP client (`@strav/brain/mcp`) that translates discovered MCP tools into framework `Tool`s and runs them through the standard loop.
- **MCP server discovery / introspection** — V1 requires you to know the server URL. V2 may add a `MCPDiscovery` service that catalogs known servers and surfaces capabilities to UIs.
- **OAuth-flow MCP servers** — V1 only handles static bearer tokens. Servers that require OAuth (`linear.app`, `notion.com`) need an out-of-band token exchange today; the in-flight OAuth handshake is a separate slice.
- **Per-tool permission policies** — V1 supports allowlist via `tools.allowedTools`. V2 may add `always_ask` / `always_allow` policies similar to Anthropic's Managed Agents.
- **`@strav/brain/mcp` sub-path** — the standalone MCP client lives here when it ships, sharing types with this top-level surface.

## When NOT to use MCP

- **Internal tools.** If you control the implementation, `defineTool` is simpler — no network round-trip, no auth flow, full type safety.
- **High-throughput tool calls.** MCP servers add a network hop per call. For latency-sensitive agents, local tools win.
- **One-off integrations.** MCP shines when you're plugging into a service you don't own (Linear, Notion, GitHub). For a custom service your team owns, `defineTool` + your service's existing SDK is faster.
