# Cancellation — `options.signal`

Every brain operation that does I/O — `chat`, `stream`, `countTokens`, `generate`, `runTools`, `streamTools`, `generateWithTools`, `streamGenerateWithTools` — accepts a standard `AbortSignal` on `options.signal`. Aborting the signal:

- Cancels the in-flight provider SDK call (Anthropic / OpenAI / Gemini all forward the signal to their fetch layer).
- Bails the agentic loop between iterations (a `signal.aborted` check fires before each next model call, so cancellation lands cleanly even mid–tool execution).
- Propagates into `ToolContext.signal`, so tools that wrap network calls (HTTP, MCP servers, child processes) can pass it through.
- Propagates into MCP — both `MCPClient.listTools(...)` / `callTool(...)` and the resolved-tool wrappers used by the local-client path forward the signal to `@modelcontextprotocol/sdk`.

## Basic shape

```ts
const ac = new AbortController()
setTimeout(() => ac.abort(), 5_000)   // 5-second timeout

try {
  const { text } = await brain.chat('Long-running prompt…', { signal: ac.signal })
} catch (err) {
  if ((err as { name?: string }).name === 'AbortError') {
    // user / timeout cancellation — render appropriately
  } else {
    throw err
  }
}
```

The error shape comes from the underlying SDK / `DOMException` — the framework doesn't wrap it (apps already have `.name === 'AbortError'` checks they expect).

## Streaming

```ts
const ac = new AbortController()
const stop = setTimeout(() => ac.abort(), 30_000)

try {
  for await (const event of brain.streamTools(prompt, tools, { signal: ac.signal })) {
    if (event.type === 'text') process.stdout.write(event.delta)
  }
} catch (err) {
  if ((err as { name?: string }).name !== 'AbortError') throw err
} finally {
  clearTimeout(stop)
}
```

Streaming iterators reject on the next `for await` step after abort.

## Inside tools

When the run carries a signal, each tool's `execute(input, ctx)` sees it on `ctx.signal`. Forward it to anything network-bound:

```ts
const searchTool = defineTool({
  name: 'search',
  description: 'Hits the public web.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  async execute({ query }, ctx) {
    const res = await fetch(`https://example.com/q?${query}`, { signal: ctx.signal })
    return await res.text()
  },
})
```

Tools that don't accept a signal (slow CPU work, third-party SDKs without abort support) will still finish their current invocation; the loop bails on the next iteration check.

## Inter-iteration check

Each provider's tool loop checks `signal.aborted` before:

1. Starting the next model call.
2. (Streaming) Yielding the next `iteration_start` event.

So if a user clicks Cancel while a tool is executing, the tool finishes, the next-iteration check fires, the loop throws `AbortError` out of the iterator, and the caller's `try/catch` (or `for await … catch`) sees a clean cancellation.

## MCP local client

`MCPClient` exposes signal forwarding on both methods:

```ts
const client = new MCPClient(serverConfig)
await client.callTool('list_issues', { limit: 3 }, { signal: ac.signal })
await client.listTools({ signal: ac.signal })
```

The Streamable-HTTP transport from `@modelcontextprotocol/sdk` cancels the in-flight HTTP request when the signal fires.

## What's NOT covered

- **Aborting a tool's execution from the framework side** — V1 won't kill a running tool; it relies on the tool itself respecting `ctx.signal`. Tools that can't be cancelled (synchronous CPU-bound work, third-party calls without an abort hook) will continue to completion before the loop bails.
- **Graceful tool-error recovery from cancellation** — aborted runs throw out of the iterator. Future graceful-recovery work might allow surfacing cancellation to the model so it can wrap up cleanly; not in V1.
