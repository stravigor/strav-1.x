# Persistence — recommended schema + `BrainStore`

`@strav/brain` keeps conversations in memory by default — `Thread`
holds an append-only `messages` array, and `SuspendedRun.state` is
a JSON-serializable snapshot. Real apps need both to live in
Postgres so threads survive restarts, suspended runs survive
process boundaries, and per-tenant isolation is enforced at the
database level.

This guide is the recommended way to do that. The sub-path
`@strav/brain/persistence` ships three schemas, three repositories,
a `BrainStore` interface, and a default `DatabaseBrainStore`
implementation. Apps that need a different backend implement the
interface directly; the schemas + repositories are conveniences,
not obligations.

## What you get

- **`brainThreadSchema`** — one row per conversation. Carries
  `system`, `options`, `last_response_id`, an app-defined
  `user_id`, an optional `title`, and timestamps.
- **`brainMessageSchema`** — one row per turn, append-only, FK to
  `brain_thread` with `ON DELETE CASCADE`. Columns include
  `role`, `content` (JSONB — `string | ContentBlock[]`), `model`,
  `usage`, `stop_reason`, `response_id`. Compaction blocks,
  tool_use, tool_result, image, document, audio — every
  `ContentBlock` variant survives the round-trip.
- **`brainSuspendedRunSchema`** — one row per paused agentic
  loop. Carries the `pending_tool_calls` array and the
  `SuspendedState` snapshot. `thread_id` is nullable for
  standalone runs (cron jobs, queued workers).
- **`BrainStore`** — the storage abstraction.
- **`DatabaseBrainStore`** — Postgres-backed default, composing
  the three repositories.

All three schemas are `tenanted: true` — `@strav/database`
auto-injects a `tenant_id` FK and emits RLS policies. Inside
`tenants.withTenant(tenantId, async () => { ... })` every query
scopes automatically; cross-tenant leaks are blocked at the
database level, not the application layer.

## Install

```ts
import {
  brainThreadSchema,
  brainMessageSchema,
  brainSuspendedRunSchema,
  DatabaseBrainStore,
} from '@strav/brain/persistence'
```

### 1. Register the schemas

Mirror the `@strav/auth` pattern — register every schema with the
app's `SchemaRegistry` at boot:

```ts
import { SchemaRegistry } from '@strav/database'

app.resolve(SchemaRegistry).registerAll([
  brainThreadSchema,
  brainMessageSchema,
  brainSuspendedRunSchema,
])
```

### 2. Ship a migration

The package follows the convention every other Strav package uses
— it doesn't auto-generate migrations. Ship one in your app's
`database/migrations/` folder using `emitCreateTable`:

```ts
// database/migrations/20260530000000_create_brain_tables.ts
import { emitCreateTable, emitDropTable, type Migration } from '@strav/database'
import {
  brainThreadSchema,
  brainMessageSchema,
  brainSuspendedRunSchema,
} from '@strav/brain/persistence'

export const migration: Migration = {
  name: '20260530000000_create_brain_tables',
  async up(db) {
    await db.execute(emitCreateTable(brainThreadSchema, { registry }).sql)
    await db.execute(emitCreateTable(brainMessageSchema, { registry }).sql)
    await db.execute(emitCreateTable(brainSuspendedRunSchema, { registry }).sql)
    // Recommended indexes — the schema system doesn't emit non-PK indexes.
    await db.execute(`
      CREATE UNIQUE INDEX idx_brain_message_thread_turn
        ON "brain_message" ("thread_id", "turn_index")
    `)
    await db.execute(`
      CREATE INDEX idx_brain_message_response_id
        ON "brain_message" ("response_id")
        WHERE "response_id" IS NOT NULL
    `)
    await db.execute(`
      CREATE INDEX idx_brain_thread_user_id
        ON "brain_thread" ("user_id")
        WHERE "user_id" IS NOT NULL
    `)
    await db.execute(`
      CREATE INDEX idx_brain_suspended_run_status
        ON "brain_suspended_run" ("status", "created_at" DESC)
    `)
  },
  async down(db) {
    await db.execute(emitDropTable(brainSuspendedRunSchema.name).sql)
    await db.execute(emitDropTable(brainMessageSchema.name).sql)
    await db.execute(emitDropTable(brainThreadSchema.name).sql)
  },
}
```

`registry` is the `SchemaRegistry` instance with every framework
schema registered. The emitter needs it to resolve foreign-key
references (`brain_message.thread_id` → `brain_thread`).

### 3. Resolve the store

The store is `@inject()`-decorated and resolved by the container
the same way `SessionRepository` is for auth:

```ts
import { DatabaseBrainStore } from '@strav/brain/persistence'

const store = app.resolve(DatabaseBrainStore)
```

## Using the store

The store is parallel to `Thread`. The mental model: the in-memory
`Thread` is for the request's lifetime; the store is the durable
home.

```ts
import { Thread } from '@strav/brain'

// Create a fresh thread
const { id } = await store.createThread({
  userId: currentUser.id,
  title: 'Onboarding',
  system: 'You help new users get started.',
})

// On the next request, load + send + persist
const loaded = await store.loadThread(id)
if (!loaded) throw new Error('thread not found')

const thread = Thread.fromJSON(brain, loaded.state)
await store.appendTurn(id, { role: 'user', content: 'how do I X?' })

const result = await brain.chat(thread.messages, loaded.state.options)
thread.messages.push({ role: 'assistant', content: result.text })

await store.appendTurn(id, {
  role: 'assistant',
  content: result.content ?? result.text,   // ContentBlock[] when present
  model: result.model,
  usage: result.usage,
  stopReason: result.stopReason ?? undefined,
  responseId: result.responseId,            // bumps last_response_id too
})
```

When `responseId` is passed to `appendTurn`, the store also bumps
the parent thread's `last_response_id` — so the next `loadThread`
returns a `ThreadState.lastResponseId` that the OpenAI Responses
provider threads forward automatically.

### Compaction blocks round-trip

When the model emits a `compaction` block (Anthropic
`compact-2026-01-12`), pass `result.content` (not `result.text`)
to `appendTurn`. The structured form is what survives later
sends:

```ts
await store.appendTurn(id, {
  role: 'assistant',
  content: result.content ?? result.text,
  // ...
})
```

The `encryptedContent` blob inside the compaction block is opaque
and round-trips verbatim through JSONB.

### Suspended runs

```ts
import { isSuspended } from '@strav/brain'

const out = await brain.runTools(prompt, tools, {
  shouldSuspend: (call) => DESTRUCTIVE.has(call.name),
})

if (isSuspended(out)) {
  const { id: runId } = await store.saveSuspendedRun({
    threadId,
    userId: currentUser.id,
    pendingToolCalls: out.pendingToolCalls,
    state: out.state,
  })
  // ... obtain approval out-of-band ...
}

// Later, when the human approves:
const loaded = await store.loadSuspendedRun(runId)
const resumed = await brain.resumeTools(
  loaded.state,
  approvedResults,
  tools,
)
await store.markSuspendedRunStatus(runId, 'resumed')
```

`listPendingSuspendedRuns({ userId })` paginates the approval
queue, sorted newest-first.

## Multitenancy

Inside `tenants.withTenant(...)`, every call automatically scopes
to that tenant — no application-level filter shows up in the
store code. The RLS policy at the database layer is the enforcer:

```ts
import { TenantManager } from '@strav/database'

const tenants = app.resolve(TenantManager)

await tenants.withTenant(workspace.id, async () => {
  const { id } = await store.createThread({ userId: user.id })
  // ... every store call inside this block is scoped to workspace.id ...
})
```

Threads created under one tenant are invisible to queries running
under another, even when the app code tries to load by id —
Postgres returns `NOT FOUND` because the row fails the RLS check.

## Overriding the default

Three levers, from least to most invasive:

1. **Subclass a repository** to add domain queries.
   ```ts
   class MyThreadRepo extends BrainThreadRepository {
     async findActiveSince(userId: string, since: Date) {
       return this.query()
         .where('user_id', userId)
         .where('updated_at', '>', since)
         .orderBy('updated_at', 'desc')
         .get()
     }
   }
   ```

2. **Add a side table** for extra per-thread metadata
   (tags, archived flag, summary). The framework's schemas are
   immutable — apps that need extension data create a separate
   `app_thread_metadata` schema joined by `thread_id`. Standard
   Strav pattern; avoids any conflict with the framework schema.

3. **Implement `BrainStore` against a different backend**. The
   schemas + repositories are conveniences for the Postgres path;
   apps targeting Redis / Mongo / DynamoDB / in-memory write
   their own implementation. The interface is small and the
   contract round-trips `ThreadState` + `SuspendedRun.state`
   exactly — that's the only thing the framework cares about.

## What's NOT in V1

- **Auto-persisted `Thread`.** `Thread.persisted(store, id)` —
  attach a store, auto-write on every `send()` — would make the
  ergonomics nicer but it ties two abstractions together. The
  parallel-store pattern keeps both surfaces independent and
  testable. Revisit if apps ask for it.
- **Cost analytics queries.** Apps build their own SQL views over
  `brain_message.usage` for per-user / per-model rollups. The
  schema indexes `(thread_id, turn_index)` and `response_id`;
  apps add indexes on `model` or a generated `(usage->>'inputTokens')`
  column if they need those queries hot.
- **Cross-version migrations.** The schemas are stable for V1.
  Future column additions ship a documented manual migration.
- **A reference Redis / Mongo store.** The interface is in place;
  no second backend ships with V1.
