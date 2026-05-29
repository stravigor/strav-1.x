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
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; argsDelta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'iteration_end'; iteration: number; stopReason: string | null }
  | { type: 'stop'; stopReason: string; iterations: number; usage: ChatUsage; messages: Message[] }
```

Lifecycle of one turn:

1. `iteration_start` — before the model call.
2. Interleaved while the model streams:
   - `text` events — text deltas from the assistant turn.
   - `tool_use_start` — fires once per tool call as soon as the model emits the call's id + name. UIs render "(calling X with …)" here.
   - `tool_use_delta` — chunks of the tool-call argument JSON. Apps accumulate by `id` and re-render to show the call composing.
3. `iteration_end` — the assistant turn fully drained, with its provider stop reason.
4. For each tool the model called this turn:
   - `tool_use` — the framework parsed the call (full input ready); about to execute. **Source of truth** — cross-provider consumers can rely on this even when `tool_use_start` / `tool_use_delta` weren't fired.
   - `tool_result` — execution finished; the result is about to be fed back to the model.
5. Repeat from `iteration_start` for the next turn, or finish with `stop`.

`stop` is always terminal. Its `stopReason` is `'end_turn'` (or the provider's equivalent) on a clean finish, or `'max_iterations'` when the safety ceiling was hit. `messages` is the full trace — equivalent to `AgentResult.messages` — so apps can persist it without consuming each event individually.

## Progressive tool-call rendering

Apps that want to show a tool call composing in real time (chat UIs, dashboards) consume `tool_use_start` + `tool_use_delta`:

```ts
const argsByCallId = new Map<string, string>()

for await (const event of brain.streamTools(prompt, [searchTool])) {
  switch (event.type) {
    case 'tool_use_start':
      argsByCallId.set(event.id, '')
      renderToolHeader(event.id, event.name)
      break
    case 'tool_use_delta':
      argsByCallId.set(event.id, (argsByCallId.get(event.id) ?? '') + event.argsDelta)
      renderToolArgsProgressive(event.id, argsByCallId.get(event.id)!)
      break
    case 'tool_use':
      // Final parsed input — render the "calling X(...)" line definitively.
      renderToolFinal(event.id, event.input)
      break
  }
}
```

The accumulated `argsDelta` chunks form valid JSON only at the end of the stream — mid-stream the string is partial. Apps that want pretty-printed progressive rendering parse opportunistically (try `JSON.parse`, swallow errors) or just render the raw partial text.

Cross-provider safety: `tool_use_start` + `tool_use_delta` are **optional** — Gemini doesn't emit them. Apps that target multiple providers always handle the `tool_use` event as the source of truth, and treat the start/delta events as best-effort UI hints.

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

All V1 providers implement `streamWithTools`:

- **Anthropic** — `messages.stream()` (or `beta.messages.stream` when MCP is in play). Yields `content_block_start` for the tool_use block (→ `tool_use_start`) and `input_json_delta` chunks (→ `tool_use_delta`) for streaming arguments. Text streams via `text_delta`. The final `tool_use` event fires post-stream with the parsed input.
- **OpenAI** — `chat.completions.create({ stream: true, stream_options: { include_usage: true } })`. Tool calls arrive as delta fragments indexed by `tool_calls[].index`; the provider emits `tool_use_start` on the first chunk carrying `id + name`, then `tool_use_delta` for each subsequent `function.arguments` chunk. `tool_use` fires after `finish_reason: 'tool_calls'` is seen.
- **Gemini** — `models.generateContentStream(...)`. Text parts surface as chunks; **`functionCall` parts arrive fully formed**, so Gemini does NOT emit `tool_use_start` / `tool_use_delta` — only the post-iteration `tool_use` event. Apps that need progressive tool-call rendering on Gemini have to wait for `tool_use`.
- **DeepSeek + Ollama** — same OpenAI-compat layer, same `tool_use_start` / `tool_use_delta` behavior (model-dependent — Ollama with non-function-calling models won't emit tool_calls at all).

The on-the-wire shape differences are hidden behind the unified `AgentStreamEvent` vocabulary. Apps consume the same events regardless of which provider is configured.

## When NOT to use `streamTools`

- **You only need the final answer.** Stick with `runTools` — it's cleaner and you don't need to handle the event union.
- **You're batching agent runs from a worker.** Streaming adds connection-management overhead without giving you anything if no human is watching.
- **You need backpressure.** V1 doesn't support backpressure on the iterator. Cancellation works (`options.signal` — see [`cancellation.md`](./cancellation.md)).

## What's deferred

- **Graceful tool-error recovery.** Tool throws abort the iterator; future slices will let apps opt into "feed the error back to the model and let it adapt."
