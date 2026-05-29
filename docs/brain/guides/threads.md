# Multi-turn conversations with `Thread`

`Thread` is `@strav/brain`'s multi-turn primitive. It owns an append-only message history, sends each turn through `BrainManager.chat`, and serializes the whole conversation so apps can persist it across requests.

This guide covers the common patterns: starting a thread, persisting it, and the tradeoffs vs. building the same shape manually.

## What `Thread` does for you

```ts
const thread = new Thread(brain, { system: 'You are a helpful coding assistant.' })

await thread.send('How do I parse JSON in TypeScript?')
await thread.send('What about nested arrays?')   // sees the previous Q+A
await thread.send('Can you show me an example?')
```

Each `send`:

1. Appends a `user`-role message to `thread.messages`.
2. Calls `brain.chat(thread.messages, {...mergedOptions})`.
3. Appends the assistant's reply as an `assistant`-role message.
4. Returns the assistant's text.

The full conversation history flows through every call — that's how the model knows what was said earlier. No magic.

## Persistence

`Thread` is designed to round-trip through JSON:

```ts
const thread = new Thread(brain, { system: '…' })
await thread.send('first question')

// Save it somewhere.
await db.execute(
  'INSERT INTO conversation (id, state) VALUES ($1, $2)',
  [conversationId, JSON.stringify(thread.toJSON())],
)

// Later, in a different request:
const row = await db.queryOne('SELECT state FROM conversation WHERE id = $1', [conversationId])
const restored = Thread.fromJSON(brain, JSON.parse(row.state))
await restored.send('follow-up question')   // continues the conversation
```

The serialized `ThreadState` carries:

- The full `messages` array (every prior turn)
- The `system` prompt (so it's reapplied)
- The default `options` (so model / tier / maxTokens stay consistent)

The `BrainManager` itself is rebuilt at app boot — only the state lives on disk.

### Postgres storage tip

If you're storing threads in Postgres, use a `jsonb` column:

```ts
defineSchema('conversation', Archetype.Entity, (t) => {
  t.id()
  t.string('user_id').max(26)
  t.json<ThreadState>('state')
  t.timestamps()
})
```

The `@strav/database` `t.json<T>()` builder types the column for you, and `hydrateRow` (per the alpha.5 fix) parses jsonb back to objects.

## The system prompt is thread-owned

Per-call `options.system` is ignored — the thread's system applies to every turn:

```ts
const thread = new Thread(brain, { system: 'be terse' })
await thread.send('hi', { system: 'be verbose' })   // ← ignored; 'be terse' applies
```

This is on purpose. If per-call `system` overrode the thread's, a caller could silently drift the conversation by changing the system prompt every turn, leaking earlier context's framing or breaking caching invariants. Apps that genuinely need to change the system prompt construct a new thread.

## Other options merge over thread defaults

Non-`system` options merge with the thread's defaults, with per-call winning:

```ts
const thread = new Thread(brain, {
  system: 'You are an assistant.',
  options: { maxTokens: 500, tier: 'balanced' },
})

// This send uses tier: 'powerful' but inherits maxTokens: 500
await thread.send('hard question', { tier: 'powerful' })
```

## What `Thread` does NOT do

V1 deliberately ships a minimal feature set. Things you might expect that aren't here:

- **Auto-compaction (client-side pruning).** Long threads accumulate without bound. Apps that need bounded context prune `thread.messages` in place. Or — better — opt the thread into Anthropic's server-side compaction by setting `options: { compact: {} }` at construction time. See [guides/compaction.md](./compaction.md) for the full pattern.
- **Streaming `send()`.** The `send` method awaits the full reply. For token-by-token streaming inside a conversation, call `brain.stream(thread.messages.concat({ role: 'user', content: text }))` directly — the thread is just a convenient state container, not a hard requirement.
- **Tool use / agents.** Lands when `@strav/brain` ships its tool / agent layer.
- **Branching.** One thread = one conversation. If you need "fork conversation at turn N and explore two replies," clone with `Thread.fromJSON(brain, original.toJSON())` and mutate one independently.

### Stateful conversations (OpenAI Responses)

When the thread's underlying provider is `OpenAIResponsesProvider`,
`Thread` auto-threads `previous_response_id` across `send()` calls.
The last response id is stored on `thread.lastResponseId` (and
included in `toJSON()` so persisted threads keep the pointer when
restored). Apps don't need to manage it manually — but per-call
`options.previousResponseId` on `send()` always wins, which is
useful for rewinding or branching from an older response.

For every other provider, `lastResponseId` stays undefined and the
`previousResponseId` field is silently ignored.

## When NOT to use `Thread`

- **One-shot calls.** `brain.chat(prompt)` is what you want. `Thread` adds nothing.
- **Multi-step orchestrations.** "Classify → route → summarize" is not a conversation — it's a workflow. Reach for `@strav/workflow`; each step's handler can call `brain.chat(...)`.
- **Long-lived state per entity that's not conversational.** If you're tracking "what the agent knows about user X across all interactions," that's memory, not a thread. (Future: `@strav/brain` Managed Agents sub-path will integrate Anthropic's memory store; today, you build it yourself with `@strav/database`.)

## Custom state extensions

If you need to attach app-specific metadata to a thread (e.g. tags, summary, user ID), wrap `Thread` instead of subclassing:

```ts
interface ConversationRow {
  id: string
  userId: string
  tags: string[]
  state: ThreadState
}

class Conversation {
  constructor(
    readonly row: ConversationRow,
    private readonly thread: Thread,
  ) {}

  static start(brain: BrainManager, userId: string, system: string): Conversation {
    return new Conversation(
      { id: ulid(), userId, tags: [], state: { messages: [], system } },
      new Thread(brain, { system }),
    )
  }

  static restore(brain: BrainManager, row: ConversationRow): Conversation {
    return new Conversation(row, Thread.fromJSON(brain, row.state))
  }

  async send(text: string): Promise<string> {
    const reply = await this.thread.send(text)
    this.row.state = this.thread.toJSON()    // snapshot for persistence
    return reply
  }

  serialize(): ConversationRow {
    return { ...this.row }
  }
}
```

This keeps `Thread`'s contract narrow and lets the app own its own row shape.
