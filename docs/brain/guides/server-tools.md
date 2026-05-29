# Server-side tools — `options.serverTools`

Server-side tools are work the provider's backend runs on behalf of the model: web search, Python execution, URL fetching. Unlike framework-local tools (`Tool` / `defineTool`), the model's calls don't round-trip through your process — the provider executes the tool and inlines the result in the response.

```ts
const { text } = await brain.chat(
  'What was the latest Anthropic safety paper? Summarize the key findings.',
  { serverTools: [{ type: 'web_search', maxUses: 3 }] },
)
```

No framework tool execution, no agentic loop, no `runWithTools` required — `serverTools` lives on plain `ChatOptions` so it works with `chat`, `stream`, `generate`, `runTools`, `streamTools`, and the schema variants. The model decides whether to use the tool; if it does, the result is in the response before `chat()` returns.

## Coverage matrix

| Tool | Anthropic | Gemini | OpenAI | DeepSeek | Ollama |
|---|---|---|---|---|---|
| `web_search` | yes (`web_search_20260209`) | yes (Google Search) | throws | throws | throws |
| `code_execution` | yes (`code_execution_20260120`) | yes | throws | throws | throws |
| `web_fetch` | yes (`web_fetch_20260309`) | throws (Anthropic-only) | throws | throws | throws |
| `url_context` | throws (Gemini-only) | yes | throws | throws | throws |

OpenAI's server tools live on the Responses API (`file_search`, `code_interpreter`, `web_search`, `computer_use`) which is a different endpoint than chat completions. A `OpenAIResponsesProvider` is a separate slice; this slice covers the chat-completions providers.

DeepSeek + Ollama inherit OpenAI's `buildParams` and throw the same way.

## `ServerTool`

```ts
type ServerTool =
  | {
      type: 'web_search'
      maxUses?: number                     // Anthropic; Gemini ignores
      allowedDomains?: readonly string[]   // Anthropic; Gemini ignores
      blockedDomains?: readonly string[]   // Anthropic; Gemini ignores
    }
  | { type: 'code_execution' }
  | {
      type: 'web_fetch'                    // Anthropic only
      maxUses?: number
      allowedDomains?: readonly string[]
      blockedDomains?: readonly string[]
    }
  | { type: 'url_context' }                // Gemini only
```

Per-provider knobs (max uses, domain caps) flow through where the provider supports them. Gemini silently drops the ones it doesn't model — same call shape, different on-wire behavior. Apps targeting cross-provider portability stick to `web_search` + `code_execution` and accept that domain controls only bind on Anthropic.

## Web search

```ts
// Anthropic — full control
await brain.chat(question, {
  serverTools: [{
    type: 'web_search',
    maxUses: 5,                                        // cap at 5 searches per turn
    allowedDomains: ['arxiv.org', 'aclanthology.org'], // restrict the corpus
  }],
})

// Gemini — knobs ignored; just enable
await brain.chat(question, {
  serverTools: [{ type: 'web_search' }],
  provider: 'google',
})
```

What the provider returns:

- **Anthropic** — `server_tool_use` + `web_search_tool_result` content blocks in `result.messages[-1].content`. The model's final text references the search.
- **Gemini** — citations land on `result.raw.candidates[0].groundingMetadata`. The model's text incorporates the answers verbatim.

Apps that want to render citations / sources iterate over the typed message blocks (Anthropic) or read `raw` (Gemini).

## Code execution

```ts
const { text } = await brain.chat(
  'Find all primes between 1000 and 2000 and sum them. Show your work.',
  { serverTools: [{ type: 'code_execution' }] },
)
```

The model writes Python, the provider runs it, the result lands inline. Same shape on Anthropic + Gemini — no per-tool config.

**Anthropic** — emits `server_tool_use` + `code_execution_tool_result` blocks (with stdout / stderr / return_code / file refs).

**Gemini** — execution traces on `result.raw.candidates[0].content.parts` as `executableCode` and `codeExecutionResult` parts. The model's final text incorporates the output.

## URL handling — `web_fetch` vs `url_context`

The two providers split the URL-fetching API:

- **`web_fetch`** — Anthropic. Send the URL as the model's question, model fetches and analyzes.
- **`url_context`** — Gemini. Same intent; different wire shape.

There's no portable cross-provider mode — apps either pick one and stick to that provider, or branch on `config.brain.default`. For most use cases, the simpler pattern is to `fetch` the URL yourself + send the text as a regular user message.

```ts
// Anthropic
await brain.chat(
  'Read https://example.com/contract and extract the termination clauses.',
  { serverTools: [{ type: 'web_fetch', maxUses: 1 }] },
)

// Gemini
await brain.chat(
  'Read https://example.com/contract and extract the termination clauses.',
  { serverTools: [{ type: 'url_context' }], provider: 'google' },
)
```

## Combining with framework tools + MCP

Server tools combine freely with framework-local `Tool[]` and MCP servers — the model sees all three sets in one tool list:

```ts
await brain.runTools(
  'Research the Q3 earnings, search internal docs, and email a summary.',
  [emailSummaryTool],                              // framework tool — runs in your process
  {
    serverTools: [{ type: 'web_search' }],         // server tool — runs on Anthropic
    mcpServers: [{ name: 'docs', url: '...' }],    // MCP tool — runs via local MCP client
  },
)
```

The model picks the right tool per step; the framework's agentic loop executes the local tool, MCP tools resolve through `@strav/brain/mcp`, and server tools fire on the provider's side without round-tripping.

## Observability

Server-tool results land on `result.messages` (and `raw`) for inspection:

```ts
const result = await brain.chat(question, { serverTools: [{ type: 'web_search' }] })

// Anthropic — typed blocks
for (const message of result.messages) {
  if (message.role !== 'assistant' || typeof message.content === 'string') continue
  for (const block of message.content) {
    if ((block as { type: string }).type === 'server_tool_use') {
      console.log('search query:', (block as { input: { query?: string } }).input.query)
    }
  }
}

// Gemini — read grounding metadata from raw
const grounding = (result.raw as any)?.candidates?.[0]?.groundingMetadata
console.log(grounding?.searchEntryPoint?.renderedContent)
```

A typed cross-provider observability surface (`AgentStreamEvent.server_tool_use`?) lands when an app actually needs it; for now apps inspect the typed messages directly or fall back to `raw`.

## What's NOT in this slice

- **OpenAI server tools** — `file_search`, `code_interpreter`, `web_search`, `computer_use` live on the Responses API. Adding them needs an `OpenAIResponsesProvider` subclass that re-implements `chat` / `runWithTools` / `streamWithTools` against `client.responses.create`. Separate slice when an app needs it.
- **Anthropic computer use, bash, text editor** — each has its own state management (browser session, shell session, file paths) and auth shape. Each is its own slice.
- **Streaming events for server-tool execution** — the model emits server-tool calls inline as content_block_start events on Anthropic / part events on Gemini. A cross-provider streaming surface (`AgentStreamEvent.server_tool_use_start`?) deserves its own design pass; for now apps consume `tool_use` post-execution (for local tools) or read `result.messages` / `raw` (for server tools).

## When NOT to use server tools

- **You need the result before the model continues reasoning.** Server tools are fire-and-the-model-keeps-going. If you want to gate the next step on the result, use a framework-local tool and the `runTools` loop.
- **You need precise control over tool execution (rate limiting, caching, transformation).** Server tools are opaque — you can't intercept the call. Use a local tool.
- **You're targeting a provider that doesn't support them.** OpenAI / DeepSeek / Ollama throw with guidance. Cross-provider apps either branch or use local tools.
