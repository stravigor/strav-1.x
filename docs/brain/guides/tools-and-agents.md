# Tools and agents

`@strav/brain` ships two layers for tool use:

1. **`BrainManager.runTools(messages, tools, options)`** — the lower-level surface. You bring the messages, the tool definitions, and any per-run context; brain runs the agentic loop (send → detect tool_use → execute → append result → re-send) until the model returns `'end_turn'` or `maxIterations` is hit.

2. **`Agent` + `brain.agent(Class)`** — declarative sugar over `runTools`. Subclass `Agent`, set static-ish fields (instructions, tools, tier), and `brain.agent(MyAgent).input(text).run()` resolves it through the container and runs the loop.

This guide covers both.

## Defining a tool

A tool is a typed `Tool<TInput, TOutput>`. Use `defineTool` to build one:

```ts
import { defineTool } from '@strav/brain'

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get current weather for a city. Returns temperature and conditions.',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name, e.g. "San Francisco"' },
    },
    required: ['city'],
  },
  execute: async (input: { city: string }, ctx) => {
    return weatherService.lookup(input.city, ctx.context.userId as string)
  },
})
```

Anatomy:

| Field | Purpose |
|---|---|
| `name` | Model-facing identifier. Snake_case is conventional |
| `description` | The model reads this to decide when to use the tool. Be specific |
| `inputSchema` | JSON Schema (draft 2020-12). Anthropic uses it to validate model output before calling your tool |
| `execute(input, ctx)` | Runs in your process. Async. Throws propagate as `ToolExecutionError` |

`ctx` is the `ToolContext`:

```ts
interface ToolContext {
  readonly callId: string                          // matches the provider's tool_use id
  readonly context: Readonly<Record<string, unknown>>  // per-run bag from .context() / options.context
}
```

## Running a one-shot tool call

```ts
const result = await brain.runTools(
  'What is the weather in Paris?',
  [getWeather],
  { context: { userId: 'u_42' } },
)
console.log(result.text)          // model's final answer
console.log(result.iterations)    // how many tool round-trips
console.log(result.usage)         // total tokens across the whole loop
console.log(result.messages)      // full conversation including tool_use / tool_result blocks
```

The `messages` array is the audit trail — render it in a UI if you want users to see what tools the agent called.

## Using `Agent` for declarative wiring

When you have a recurring "this agent uses these tools with this persona" shape, `Agent` is cleaner:

```ts
import { inject } from '@strav/kernel'
import { Agent } from '@strav/brain'

@inject()
class ResearchAgent extends Agent {
  override readonly instructions = `You are a research assistant. Cite sources for every claim.
When asked a question, search the company knowledge base first, then summarize.`

  override readonly tools = [searchTool, summarizeTool]
  override readonly tier = 'powerful'      // claude-opus-4-7
  override readonly maxIterations = 8

  // Constructor injection works normally — brain.agent(Class) resolves
  // through the container.
  constructor(private readonly auditLog: AuditService) {
    super()
  }
}
```

Run it:

```ts
const result = await brain
  .agent(ResearchAgent)
  .input('What is our refund policy for enterprise customers?')
  .context({ userId: ctx.auth.user.id, requestId: ctx.requestId })
  .run()
```

The `.context()` bag is what each tool's `execute(input, ctx)` will see on `ctx.context`. Use it for per-request data the tools need but the model shouldn't see — auth identity, tenant id, trace ids.

### Per-call agent instances (apps with DI)

When you can't have the container construct the agent for you (you need to feed it state from the current request that isn't in the container), pass an instance explicitly:

```ts
const myAgent = new ConfiguredAgent(somePerRequestState)
const result = await brain.agent(ConfiguredAgent, myAgent).input(text).run()
```

The second arg overrides the resolver. The class argument is still required to keep the call signature typed.

### Structured output: `.output(schema)`

When an agent should return a typed object rather than free-form prose, chain `.output(schema)`:

```ts
class CityAgent extends Agent {
  override readonly instructions = 'You only emit verified city data.'
  override readonly tier = 'fast'
}

const { value } = await brain
  .agent(CityAgent)
  .input('Capital of France?')
  .output(citySchema)
  .run()
//  ^? AgentGenerateResult<CityAnswer>
```

`run()` then returns `AgentGenerateResult<T>` instead of `AgentResult`: `{ value, text, messages, iterations, stopReason, usage }`. The agent's `instructions` / `tier` / `model` / `provider` / `maxTokens` still flow through — only the underlying call shape switches from `runTools(...)` to `generate(...)` (no tools) or `generateWithTools(...)` (tools / mcpServers declared).

`.output(schema)` combines freely with `tools` and `mcpServers`. The model can still emit tool calls during the loop; only its final turn produces JSON, which is parsed against the schema. `iterations` reports how many tool-use round-trips happened.

See [`guides/structured-outputs.md`](./structured-outputs.md) for the schema shape and per-provider mapping.

## What the agentic loop does

V1 implements the manual agentic loop (see the Anthropic skill's tool-use section):

```
1. Send messages + tools to client.messages.create
2. Check stop_reason:
   - 'end_turn' → return final text + collected messages + usage
   - 'tool_use' → step 3
   - 'max_iterations' (framework) → return current state
3. For each tool_use block in the response:
   - Look up the tool by name (unknown → ToolExecutionError)
   - Run tool.execute(input, ctx)
   - Append tool_result to a single user-role turn
4. Increment iterations; if iterations >= maxIterations, return
5. Loop to 1.
```

Two things to know:

**Cache hits across the loop.** The system prompt and the tool definitions are part of the prefix on every call. If you keep them stable across runs (`config.brain.cache.auto = true` or `cache: true` on the system prompt), the second model call within the same loop reads the cache for the system + tools, paying full price only for the appended tool_use + tool_result.

**No streaming yet.** V1's `runWithTools` awaits the full final response. Streaming an agentic loop has nuanced UX questions (do you show the tool_use deltas? the thinking blocks? the final text?) — it lands when an app has a concrete requirement.

## Tool errors

When a tool's `execute` throws:

```ts
class ToolExecutionError extends StravError {
  code = 'brain.tool-execution-failed'
  status = 500
  context: { tool: string; callId: string }
  cause: unknown   // the original throw
}
```

**Default — abort the loop.** Without an `onToolError` callback, `runWithTools` / `streamWithTools` / `generateWithTools` / `streamGenerateWithTools` propagate `ToolExecutionError` and abort. The intent is that infrastructure failures (DB down, third-party API timeout) should be visible to the caller, not silently swept under the rug.

**Opt-in — let the model recover.** Pass `onToolError` and the framework will feed the failure back to the model as an `isError: true` tool_result; the model sees what went wrong and adapts (retries with different args, asks the user, gives up gracefully).

```ts
const result = await brain.runTools(prompt, tools, {
  onToolError(err) {
    // Return a string to feed back to the model:
    return `Tool failed: ${(err.cause as Error).message}. Try a different approach.`
    // Return undefined to fall back to throwing:
    // return undefined
  },
})
```

What the callback sees:

```ts
onToolError(error: ToolExecutionError): string | undefined
```

- `error.context.tool` — the tool name the model tried to call.
- `error.context.callId` — provider-assigned id of the tool_use block.
- `error.cause` — the original throw (or a synthetic `Error` describing what went wrong: "Tool 'X' is not registered", "Failed to parse tool input JSON", ...).

What the callback covers:

- **`execute()` threw.** The most common case.
- **Tool not registered.** The model called a name your `tools` array doesn't include — common when a previous-turn tool was removed or renamed.
- **Tool input wasn't valid JSON** (OpenAI only — Anthropic + Gemini parse arguments themselves). Useful when models produce malformed argument streams under load.

**Per-error filtering.** Common pattern: feed back transient failures, rethrow programmer / config errors:

```ts
onToolError(err) {
  if (err.cause instanceof TransientApiError) return err.cause.message
  return undefined  // rethrow ToolExecutionError
}
```

**Streaming.** When `onToolError` recovers a failure inside `streamWithTools` (or its schema twin), the emitted `tool_result` event carries `isError: true` and the loop continues to the next iteration. Apps that render error indicators in UIs switch on the flag:

```ts
for await (const event of brain.streamTools(prompt, tools, { onToolError: handler })) {
  if (event.type === 'tool_result' && event.isError) {
    renderToolFailure(event.name, event.content)
  }
}
```

## Designing tools

A few patterns that work:

**Be specific in the description.** "Lookup user info" is too vague. "Look up a user by email. Returns name, signup date, and current plan. Use this when the user asks 'who am I' or refers to themselves." gives the model enough to decide.

**Keep tools narrow.** One tool per discrete action. The model handles tool *choice* better when each tool does one thing. Five focused tools beat one general-purpose tool with a `command` field.

**Validate inputs.** The model produces JSON matching your `inputSchema`, but it's still untrusted output. Validate with Zod / ajv / your validator of choice inside `execute` if the cost of acting on bad input is high. The schema catches structure errors; semantic checks (does this user_id exist?) belong in your handler.

**Pass identity via context, not input.** The model shouldn't have to "guess" the user id. Put it on `ctx.context` and let `execute` read it.

**Make tools idempotent if they have side effects.** The model can call the same tool more than once (e.g. as the result of a retry on its end). Idempotency keys on POST requests, ON CONFLICT DO NOTHING on inserts, etc.

## When NOT to use tools

- **Pure transformations.** "Summarize this text" doesn't need tools — it's a one-shot `brain.chat(prompt)`.
- **Workflows with fixed steps.** "Validate → charge → ship" is a `@strav/workflow`, not an agent. Workflows compose handlers under code control; agents compose tools under model control.
- **Critical exact-output requirements.** When the result has to be machine-parseable, prefer structured outputs (lands in a later slice) over giving the model a tool and parsing its conversational reply.

## Provider support

V1 supports tools on `AnthropicProvider` only. The `Provider` interface declares `runWithTools` as optional; OpenAI / Gemini / DeepSeek providers land in later slices and will populate it. `BrainManager.runTools` throws `BrainError` when the configured provider doesn't implement the method.
