# Human-in-the-loop tool gating

The agentic loop normally executes every tool the model calls.
Sometimes you don't want that — a destructive operation (`drop_db`,
`refund_customer`, `delete_user`) should pause for human approval
before it runs. The brain package exposes this as **suspend /
resume**.

## Surface

Three additions:

- `RunWithToolsOptions.shouldSuspend(call, context?)` — predicate
  evaluated before each tool execution. Return `true` to pause the
  loop; `false` (or omit) to execute as usual.
- `SuspendedRun` — what `runWithTools` returns when the loop paused.
  Carries `pendingToolCalls: ToolUseBlock[]` and a JSON-serializable
  `state` snapshot of the conversation.
- `brain.resumeTools(state, results, tools, options?)` — append
  results for the pending calls and continue the loop. Returns
  another `AgentResult | SuspendedRun` — the resumed run can pause
  again on the next tool.

`isSuspended(value)` is the type guard. Use it to discriminate the
return:

```ts
import { isSuspended } from '@strav/brain'

const out = await brain.runTools(prompt, tools, {
  shouldSuspend: (call) => DESTRUCTIVE.has(call.name),
})

if (isSuspended(out)) {
  await persistForLater({
    pending: out.pendingToolCalls,
    state: out.state,
  })
  return
}
render(out.text)
```

When you're ready to continue:

```ts
const resumed = await brain.resumeTools(
  state,
  pending.map((call) => ({
    toolUseId: call.id,
    content: humanApprovedResult(call),
  })),
  tools,
)
```

## Mid-batch invariant

The model can request multiple tool calls in a single assistant turn.
If your `shouldSuspend` gate fires for one of them, the framework
also captures every **unexecuted** sibling from that same turn — the
provider's `tool_use` / `tool_result` pairing must remain balanced
on resume, otherwise the next request rejects upstream.

You MUST supply a result for every entry in `pendingToolCalls`. To
deny a call (decline the destructive operation, return an error to
the model), pass a string describing the rejection as `content` and
set `isError: true`:

```ts
await brain.resumeTools(state, [
  { toolUseId: 'a', content: 'completed', },
  {
    toolUseId: 'b',
    content: 'Refused by reviewer: customer not eligible.',
    isError: true,
  },
], tools)
```

The model sees the error result as a normal tool failure and adapts.

## AgentRunner ergonomics

The Agent runner exposes the same pattern as `.suspend(gate)` /
`.resume(state, results)`:

```ts
const runner = brain
  .agent(OrderAgent)
  .input(text)
  .suspend((call) => DESTRUCTIVE.has(call.name))

const out = await runner.run()

if (isSuspended(out)) {
  // ... obtain human approval ...
  const resumed = await runner.resume(out.state, [
    { toolUseId: 'tu_1', content: 'approved' },
  ])
  console.log(resumed.text)
}
```

The runner's static type widens to `AgentRunResult<T> | SuspendedRun`
the moment you call `.suspend(...)`, so the compiler reminds you to
narrow.

## V1 scope

`shouldSuspend` is honored on the non-streaming `runTools` /
`runWithTools` path only. Passing it to:

- `streamTools` / `streamWithTools`
- `generateWithTools` / `runWithToolsAndSchema`
- `streamGenerateWithTools` / `streamWithToolsAndSchema`

throws `BrainError` with a clear "use runTools instead" message. The
pause / resume protocol over the streaming + schema variants is a
deferred slice — the state-capture semantics around partial token
streams aren't settled yet. Apps that need structured output with
HITL today run `runTools` first (gating as needed), then call
`brain.generate(...)` on the final messages for the structured
summary as a separate step.

## Iteration + usage counts across resume

`AgentResult.iterations` and `.usage` aggregate across the entire
run — including the pre-suspension portion. The framework carries
the snapshot's `state.iterations` + `state.usage` forward through
`resumeTools` so apps see one cumulative total per conversation
even after multiple pause/resume cycles. The `+1` adjustment
accounts for the round that was paused: at suspension we hadn't
yet incremented the counter, so completing the suspended round on
resume bumps it.

## Persistence

`SuspendedRun.state` is plain JSON. The intended pattern: one row
per pending run, indexed by something the app already has (request
id, user id, workflow run id):

```sql
create table pending_runs (
  id uuid primary key,
  user_id uuid references users(id),
  state jsonb not null,
  pending_calls jsonb not null,
  created_at timestamptz not null default now()
);
```

`state.responseId` — captured automatically when the provider
exposes stateful conversations (OpenAI Responses API) — threads
back through `previousResponseId` on resume so the server picks up
exactly where it paused. Apps don't need to manage it.

## Cross-provider support

V1 honors `shouldSuspend` on all four `runWithTools` loops:

- `AnthropicBrainDriver`
- `OpenAIBrainDriver` (chat completions)
- `OpenAIResponsesBrainDriver`
- `GeminiBrainDriver`

The OpenAI-compat subclasses (`DeepSeekBrainDriver`, `OllamaBrainDriver`)
inherit the chat-completions loop and therefore also support it.
