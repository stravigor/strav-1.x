# Server-side compaction

Long conversations bloat input tokens. The naive fix is to prune the
oldest turns client-side, but that loses information silently.
Anthropic's `compact-2026-01-12` beta does it the right way: the
server summarizes older turns into a single typed block on the
response, and apps round-trip that block on subsequent requests.
The model sees the summary instead of the raw history, and the
older turns drop out of context for good.

This guide covers the framework's compaction surface and how it
plugs into `Thread`.

## Surface

Three additions:

- `ChatOptions.compact?: CompactConfig` — opts in per call. All
  fields optional; omitting `trigger` uses the server default of
  150,000 input tokens.
- `ChatResult.content?: ContentBlock[]` — structured assistant
  content. Populated when the turn includes blocks beyond plain
  text — today that means a `CompactionBlock`.
- `CompactionBlock` — `{ type: 'compaction', content, encryptedContent }`.
  Apps that persist conversations push these onto the message
  history alongside text blocks so the next request can echo them
  back.

```ts
const result = await brain.chat(messages, {
  compact: {
    trigger: 80_000,                // fire once we hit ~80k input tokens
    instructions: 'keep customer ids and PR numbers',
    pauseAfterCompaction: false,    // default — keep generating
  },
})

if (result.content) {
  // Provider returned at least one non-text block (compaction here)
  // — persist this in place of `result.text`.
  saveTurn(role: 'assistant', result.content)
} else {
  saveTurn(role: 'assistant', result.text)
}
```

## Thread integrates automatically

`Thread.send()` is the high-leverage place. When the underlying
provider returns structured content, the thread stores it on the
assistant turn (in place of the plain `result.text` string). The
next `send()` echoes the compaction block back to the server, the
older turns drop out, and you save tokens with no app-side
bookkeeping.

```ts
const t = new Thread(brain, { options: { compact: {} } })

await t.send('hello')               // → normal text reply
// ... many turns later ...
await t.send('continuing the thread')
// Server hits the trigger, returns a CompactionBlock + reply text.
// Thread stores the structured form on `messages[i]`.

await t.send('one more')
// Sends previous turn with the CompactionBlock — server only re-reads
// the summary, not the raw history before compaction.
```

`toJSON()` / `fromJSON()` preserve the structured content, so a
thread persisted to Postgres restores with the compaction history
intact.

## What gets dropped, what stays

The server replaces older raw turns with the `CompactionBlock` it
returns. Inside that block:

- `content` — the summary string the model emits. `null` when
  summarization failed; the server treats null-content blocks as
  no-ops on the next request so apps don't need to special-case
  them.
- `encryptedContent` — opaque metadata the server uses to stitch
  prior compaction history together. **Apps must round-trip this
  unchanged.** Mutating it invalidates the compaction stitch and
  the next request will either reject or silently misbehave.

The framework treats `encryptedContent` as opaque too — it goes
out exactly as it came in.

## When the trigger fires

The server decides when. `trigger` is a soft threshold on input
tokens; the server checks at request time and emits the compaction
block + a fresh assistant turn in the same response. Apps that
want to inspect the summary before letting the conversation
continue set `pauseAfterCompaction: true`:

```ts
await brain.chat(messages, {
  compact: { trigger: 60_000, pauseAfterCompaction: true },
})
// Response carries the CompactionBlock but no continued
// generation. Apps re-prompt to continue.
```

`pauseAfterCompaction: false` (the default) is what you want for
transparent thread compaction — the user never sees a "we
summarized your conversation" pause.

## What's NOT in V1

- **Other providers.** Compaction is Anthropic-only. OpenAI's
  Responses API has its own server-side state via
  `previousResponseId` (see [openai-responses guide](./openai-responses.md))
  but no equivalent compaction block. Gemini has neither. Apps
  setting `compact` on a non-Anthropic call get no-op behavior —
  the option is silently ignored to keep cross-provider routing
  clean.
- **Compaction inside `runWithTools` / streaming.** The framework
  honors `compact` on every Anthropic call (chat, stream,
  runWithTools, runWithToolsAndSchema, the schema-streaming
  variant), but only `Thread.send()` auto-persists the resulting
  blocks. Apps using `runWithTools` directly handle persistence
  themselves — push `result.content` onto your own message store
  when present.
- **Inspecting compaction iterations.** The SDK returns detailed
  iteration usage on `result.raw.usage.compaction`; the
  framework's `ChatUsage` doesn't yet break those out. Apps that
  need per-iteration token accounting read `result.raw`.
