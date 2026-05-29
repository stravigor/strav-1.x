# Streaming agent loops

`BrainManager.streamTools(input, tools, options)` is the streaming twin of `runTools`. Instead of returning a single `AgentResult` at the end, it yields `AgentStreamEvent`s as the agent works — text deltas during model turns, `tool_use` / `tool_result` boundaries around tool execution, per-iteration markers, and a terminal `stop` event with the full trace.

Use it whenever you want to render an agent's progress in a UI — chat apps, dashboards, CLIs that print as the model thinks.

```ts
for await (const event of brain.streamTools('Find issue STR-42, then summarize.', [searchIssues, summarize])) {
  switch (event.type) {
    case 'iteration_start':
      console.log(`--- turn ${event.iteration} ---`)
      break
    case 'text':
      process.stdout.write(event.delta)
      break
    case 'tool_use':
      console.log(`\n[calling ${event.name}(${JSON.stringify(event.input)})]`)
      break
    case 'tool_result':
      console.log(`[← ${event.content.slice(0, 80)}…]`)
      break
    case 'stop':
      console.log(`\ndone — ${event.iterations} turn(s), ${event.usage.outputTokens} out-tokens`)
      break
  }
}
```

## Event vocabulary

```ts
type AgentStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'iteration_end'; iteration: number; stopReason: string | null }
  | { type: 'stop'; stopReason: string; iterations: number; usage: ChatUsage; messages: Message[] }
```

Lifecycle of one turn:

1. `iteration_start` — before the model call.
2. Zero or more `text` events — text deltas from the assistant turn currently in flight.
3. `iteration_end` — the assistant turn fully drained, with its provider stop reason.
4. For each tool the model called this turn:
   - `tool_use` — the framework parsed the call (full input ready); about to execute.
   - `tool_result` — execution finished; the result is about to be fed back to the model.
5. Repeat from `iteration_start` for the next turn, or finish with `stop`.

`stop` is always terminal. Its `stopReason` is `'end_turn'` (or the provider's equivalent) on a clean finish, or `'max_iterations'` when the safety ceiling was hit. `messages` is the full trace — equivalent to `AgentResult.messages` — so apps can persist it without consuming each event individually.

## Failures

The framework doesn't emit an `error` event in V1. Tool execution failures throw `ToolExecutionError` out of the iterator — the `for await` rejects. Apps that want resilient loops catch around the consumer:

```ts
try {
  for await (const event of brain.streamTools(...)) { ... }
} catch (err) {
  if (err instanceof ToolExecutionError) { ... }
}
```

Graceful tool-error recovery (the model sees the error and adapts) is a later slice.

## With `Agent`

`AgentRunner.stream()` is the runner-level streaming variant. The agent's declarative `instructions` / `tier` / `model` / `provider` / `maxTokens` / `tools` / `mcpServers` all flow through — only the underlying call shape switches from `runTools(...)` to `streamTools(...)`.

```ts
for await (const event of brain.agent(ResearchAgent).input('What changed in Q3?').stream()) {
  // …
}
```

`.stream()` combines freely with `.output(schema)`. The runner routes through `BrainManager.streamGenerateWithTools` — events flow as normal during the loop; the terminal `stop` event carries the parsed `value: T` + raw `text` alongside the loop bookkeeping. See [`guides/structured-outputs.md`](./structured-outputs.md#streaming) for the typed-stop variant.

## Per-provider mapping

All three V1 providers implement `streamWithTools`:

- **Anthropic** — `messages.stream()` (or `beta.messages.stream` when MCP is in play). The SDK helper yields raw `content_block_delta` events and exposes a `finalMessage()` accessor; the provider streams text via the deltas and uses `finalMessage` to get the structured assistant turn (text + tool_use blocks).
- **OpenAI** — `chat.completions.create({ stream: true, stream_options: { include_usage: true } })`. Tool calls arrive as delta fragments indexed by `tool_calls[].index`; the provider accumulates `id` / `name` / `arguments` across chunks and yields `tool_use` only after `finish_reason: 'tool_calls'` is seen. MCP servers route through `@strav/brain/mcp`.
- **Gemini** — `models.generateContentStream(...)`. Text parts surface as chunks; `functionCall` parts arrive fully formed (Gemini doesn't stream tool-call arguments). MCP via the local client, same as `runWithTools`.

The on-the-wire shape differences are hidden behind the unified `AgentStreamEvent` vocabulary. Apps consume the same events regardless of which provider is configured.

## When NOT to use `streamTools`

- **You only need the final answer.** Stick with `runTools` — it's cleaner and you don't need to handle the event union.
- **You're batching agent runs from a worker.** Streaming adds connection-management overhead without giving you anything if no human is watching.
- **You need backpressure.** V1 doesn't support backpressure on the iterator. Cancellation works (`options.signal` — see [`cancellation.md`](./cancellation.md)).

## What's deferred

- **Tool-argument streaming.** `tool_use` fires once the parsed input is ready, not character-by-character. Apps that want to render "calling search(q='..." as it streams will get it in a later slice.
- **Graceful tool-error recovery.** Tool throws abort the iterator; future slices will let apps opt into "feed the error back to the model and let it adapt."
