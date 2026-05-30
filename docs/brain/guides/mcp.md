# MCP — Model Context Protocol

MCP (Model Context Protocol) is the open standard for exposing tools to LLMs. The Anthropic ecosystem has growing first-party MCP server support — Linear, Notion, GitHub, Asana, and more publish hosted MCP endpoints you can connect to.

`@strav/brain` supports MCP through two paths:

1. **Anthropic — server-side connector.** Declare servers; Anthropic's backend connects, discovers tools, invokes them, and inlines `mcp_tool_use` / `mcp_tool_result` blocks in the response.
2. **OpenAI (and future Gemini / DeepSeek) — local MCP client at `@strav/brain/mcp`.** The provider dials each server itself via Streamable HTTP, discovers its tools, and surfaces them as ordinary `Tool`s in the agentic loop. Tool names are namespaced `<server>__<tool>` so multiple servers can coexist.

Both paths accept the same `MCPServer` config shape, so apps can switch providers without rewriting their server declarations.

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

## Local MCP client — `@strav/brain/mcp`

For providers without server-side MCP, the framework ships a local client at `@strav/brain/mcp`. The OpenAI provider uses it automatically when you pass `mcpServers` — there's nothing extra to wire up:

```ts
const result = await brain.runTools(
  'Summarize my open Linear issues.',
  [],
  {
    mcpServers: [
      { name: 'linear', url: 'https://mcp.linear.app', authorizationToken: env('LINEAR_MCP_TOKEN') },
    ],
  },
)
```

Behavior:

- **Transport.** Streamable HTTP (the current MCP transport). Legacy SSE-only endpoints aren't supported.
- **Tool namespacing.** Discovered tools are exposed to the model as `<server>__<tool>` (e.g. `linear__list_issues`). The framework strips the prefix before invoking the server, so MCP servers see their tool names unchanged.
- **Iteration cost.** Unlike the Anthropic server-side path, each MCP tool call *does* cost an iteration — the framework round-trips through your process between the model's tool request and the next model turn. Bump `RunWithToolsOptions.maxIterations` if you expect long MCP chains.
- **Lifecycle.** Default: transports are opened at the start of the run and closed in a `finally` once the loop exits. For long-running workers, opt into a pool (next section) to keep connections alive across calls.
- **Auth.** Two paths:
  - `MCPServer.authorizationToken` → static `Authorization: Bearer <token>`. Fine for self-hosted servers where you control the token.
  - `MCPServer.oauth` → authorization-code-with-PKCE flow. The framework drives discovery + dynamic client registration + the redirect + the token exchange. See **OAuth** below.

  The two are mutually exclusive — constructing an `MCPClient` with both throws.

If you need lower-level access — listing tools without invoking the loop, sharing a connection across requests — instantiate `MCPClient` directly:

```ts
import { MCPClient } from '@strav/brain/mcp'

const client = new MCPClient({ name: 'linear', url: 'https://mcp.linear.app', authorizationToken: token })
await client.connect()
const tools = await client.listTools()
const { content, isError } = await client.callTool('list_issues', { limit: 3 })
await client.close()
```

## Connection pooling — `MCPClientPool`

Default `MCPClient` lifecycle is connect-per-call: every `runTools` invocation handshakes a fresh Streamable HTTP transport, lists tools, runs the loop, closes. Fine for one-shot CLI scripts; expensive for long-running workers (chat servers, background processors) that fire many MCP-enabled requests against the same servers.

The fix is **`MCPClientPool`** — a long-lived, per-(server name, URL) cache of connected clients. Hand the pool to your providers at construction; the framework borrows from it on every call instead of constructing fresh.

```ts
import { MCPClientPool, OpenAIBrainDriver, GeminiBrainDriver } from '@strav/brain'

const pool = new MCPClientPool()

const openai = new OpenAIBrainDriver(
  'openai',
  { driver: 'openai', apiKey: env('OPENAI_API_KEY') },
  { mcpPool: pool },
)
const gemini = new GeminiBrainDriver(
  'gemini',
  { driver: 'google', apiKey: env('GEMINI_API_KEY') },
  { mcpPool: pool },
)

const brain = new BrainManager({
  default: 'openai',
  providers: { openai, gemini },
})

// ... handle many requests over the worker's lifetime ...

// On graceful shutdown:
await pool.close()
```

Behavior:

- **Lazy connect.** The first `borrow(server)` returns a constructed-but-not-yet-connected `MCPClient`. The first `listTools` / `callTool` call on it triggers the handshake; subsequent calls reuse the same transport.
- **Concurrency-safe.** `MCPClient.connect()` dedupes in-flight handshakes — multiple parallel borrows of the same server end up awaiting one connect, not racing.
- **`close` is a no-op when pooled.** `resolveMcpTools` skips per-call cleanup since the pool owns the lifetime. Only `pool.close()` actually shuts transports down.
- **Eviction.** Call `pool.evict(server)` to drop and close one client — useful after a re-auth flow or a transient failure where the connection state is suspect. Subsequent borrows construct a fresh client.
- **Key.** `(server.name, server.url)` — two `MCPServer` configs that differ in URL get distinct pooled clients even if they share a name.

When NOT to pool:

- **One-shot scripts.** The overhead of a single handshake at startup vs at request time is the same; pooling adds nothing.
- **Per-tenant MCP servers** keyed dynamically. The pool's key is `(name, url)`; if your app talks to N tenant-specific servers, the cache could grow unboundedly. Either evict aggressively on tenant churn, or skip the pool entirely for those workloads.

Pool support is provider-side, not request-side: every `runTools` call from a provider with `mcpPool: pool` automatically uses it. There's no per-call opt-out — if you need fresh connections occasionally, call `pool.evict(server)` first.

The Anthropic provider doesn't need the pool: Anthropic's server-side MCP path runs the MCP connector on the backend, not in the framework, so there's no client connection to pool.

## OAuth — `MCPServer.oauth`

Most commercial MCP servers (Linear, Notion, GitHub, Asana) are OAuth-protected. The framework drives the standard authorization-code-with-PKCE flow against the server's OAuth endpoints — dynamic client registration when supported, manual `client_id` when not, automatic refresh.

The shape:

```ts
interface MCPOAuthConfig {
  redirectUri: string                     // where the user comes back after authorizing
  scope?: string                          // optional OAuth scopes
  store: MCPOAuthStore                    // persists tokens + client info + PKCE verifier
  clientMetadata?: Partial<OAuthClientMetadata>
}
```

```ts
import { MemoryOAuthStore } from '@strav/brain/mcp'

const linear: MCPServer = {
  name: 'linear',
  url: 'https://mcp.linear.app',
  oauth: {
    redirectUri: 'https://myapp.com/mcp/linear/callback',
    scope: 'read',
    store: new MemoryOAuthStore(),
  },
}
```

### The flow

Because the framework is server-side and headless, it can't redirect the user inline. Instead `connect()` surfaces `MCPAuthRequiredError`:

```ts
import { MCPAuthRequiredError, MCPClient } from '@strav/brain/mcp'

try {
  const client = new MCPClient(linear)
  await client.connect()
} catch (err) {
  if (err instanceof MCPAuthRequiredError) {
    // Save (userId, server.name) somewhere so the callback handler
    // can rebuild the right store. Then redirect the user:
    res.redirect(err.authorizationUrl)
    return
  }
  throw err
}
```

On the OAuth callback route:

```ts
app.get('/mcp/linear/callback', async (req, res) => {
  const userId = await getCurrentUserId(req)
  const store = buildStoreForUser(userId, 'linear')        // your storage
  const client = new MCPClient({ ...linear, oauth: { ...linear.oauth!, store } })
  await client.completeAuthorization(req.query.code as string)
  res.redirect('/agents')                                  // user is now authorized
})
```

After `completeAuthorization` succeeds, the store has tokens. Subsequent `connect()` calls (same store) succeed silently. Refresh tokens are handled automatically.

### `MCPOAuthStore`

The persistence contract:

```ts
interface MCPOAuthStore {
  clientInformation(): OAuthClientInformation | undefined | Promise<…>
  saveClientInformation(info): void | Promise<void>
  tokens(): OAuthTokens | undefined | Promise<…>
  saveTokens(tokens): void | Promise<void>
  codeVerifier(): string | Promise<string>
  saveCodeVerifier(verifier): void | Promise<void>
}
```

`MemoryOAuthStore` is the built-in in-memory implementation — fine for tests and single-process dev. Production apps with multiple processes or restarts implement the interface against a DB, Redis, or KV. The interface is intentionally per-server; multi-tenant apps construct a fresh store per `(user, server)` with the user id baked into the storage keys.

### Multi-tenancy

There's no built-in `userId` parameter — apps key the storage themselves:

```ts
class PgOAuthStore implements MCPOAuthStore {
  constructor(private readonly userId: string, private readonly server: string) {}
  async tokens() { return await db.mcpTokens.findOne({ userId, server: this.server }) }
  async saveTokens(t) { await db.mcpTokens.upsert({ userId, server: this.server }, t) }
  // …
}
```

### What's still NOT supported

- **`client_credentials` / service-account flows** — V1 covers the interactive authorization-code path only. Servers that expose machine-to-machine creds need a follow-up.
- **Token encryption at rest** — your store implementation's responsibility.

## What's deferred

- **MCP server discovery / introspection** — apps must know the server URL up front.
- **Per-tool permission policies** — `always_ask` / `always_allow` semantics on top of the current allowlist.
- **Connection pooling.** Each `runTools` call opens fresh transports. Long-lived agents will want pooling later.
- **Resources / prompts / sampling.** Only the `tools/*` slice of MCP is exposed; the rest is on the roadmap.

## When NOT to use MCP

- **Internal tools.** If you control the implementation, `defineTool` is simpler — no network round-trip, no auth flow, full type safety.
- **High-throughput tool calls.** MCP servers add a network hop per call. For latency-sensitive agents, local tools win.
- **One-off integrations.** MCP shines when you're plugging into a service you don't own (Linear, Notion, GitHub). For a custom service your team owns, `defineTool` + your service's existing SDK is faster.
