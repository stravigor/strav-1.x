# Prompt caching with @strav/brain

Anthropic's prompt cache cuts the cost of repeated prefix tokens by ~10× and the latency by a similar margin. The tradeoff is a one-time write premium (~1.25× for the default 5-minute TTL). If your app sends the same system prompt — or the same document, or the same few-shot examples — to two or more requests within the TTL, caching pays for itself immediately.

This guide covers the mechanics in `@strav/brain` and the design constraints you have to honor for the cache to actually hit.

## The one invariant

**Prompt caching is a prefix match.** Any byte change anywhere in the prefix invalidates everything after it. Render order for Anthropic is `tools → system → messages`. A single timestamp, UUID, or non-deterministic key ordering in the system prompt invalidates the cache for every subsequent breakpoint.

The full guidance lives in the Anthropic skill (`shared/prompt-caching.md` in the `@strav/brain` upstream docs). The TL;DR for app authors:

- **Freeze the system prompt.** No `new Date()`, no per-request IDs.
- **Order content by stability.** Stable prefixes first, volatile content last.
- **Serialize deterministically.** `JSON.stringify(obj, Object.keys(obj).sort())` for any structured prefix.

If you do those three things, caching works for free. If you don't, no marker placement will help.

## How brain exposes caching

Three surfaces:

### 1. Top-level auto-caching

The simplest case — cache the last cacheable block on every call. Two ways to enable it:

**Per-call:**

```ts
const { text } = await brain.chat(prompt, {
  system: longSystemPrompt,
  cache: true,
})
```

**App-wide via config:**

```ts
// config/brain.ts
export default {
  default: 'anthropic',
  providers: { anthropic: { … } },
  cache: { auto: true },
}
```

With `cache: { auto: true }`, every `brain.chat` / `brain.stream` call defaults to `cache: true`. Per-call overrides win, so apps that want some calls uncached pass `{ cache: false }` explicitly.

### 2. Cached system prompts

If the system prompt is the main thing you want cached, pass it as the cache-aware object form:

```ts
const { text } = await brain.chat(prompt, {
  system: { text: largeSystemPrompt, cache: true },
})
```

This translates to a `TextBlockParam[]` system with `cache_control: { type: 'ephemeral' }` on the block. Cleaner than `cache: true` (top-level) when the system prompt is the only thing you're caching and you want the boundary to be explicit.

### 3. Per-block caching in messages

For RAG, few-shot examples, or any "large reference content followed by a small question," pass the content as a block list with a `cache` flag on the prefix:

```ts
const { text } = await brain.chat([
  {
    role: 'user',
    content: [
      { type: 'text', text: largeRetrievedDoc, cache: true },
      { type: 'text', text: userQuestion },     // not cached — varies every request
    ],
  },
])
```

The provider translates the `cache: true` flag to `cache_control: { type: 'ephemeral' }` on that block. The volatile suffix sits after the breakpoint, so the next request with the same doc + a different question reads the cache for the doc.

## Verifying it's working

`result.usage` (and the streamed `stop` event's `usage`) carries cache-hit counters:

```ts
const { usage } = await brain.chat(prompt, { system: { text: sys, cache: true } })
console.log('input (uncached):', usage.inputTokens)
console.log('cache write:',      usage.cacheCreationTokens)
console.log('cache read:',       usage.cacheReadTokens)
console.log('output:',           usage.outputTokens)
```

- **First request:** `cacheCreationTokens > 0`, `cacheReadTokens = 0`. You paid the write premium.
- **Subsequent requests within TTL:** `cacheCreationTokens = 0`, `cacheReadTokens > 0`. You paid ~10% of the input cost.
- **`cacheReadTokens` stays 0 across repeated requests:** Something is invalidating the prefix. Audit for `new Date()` in the prompt, non-deterministic JSON, varying betas, model changes.

The total prompt size = `inputTokens + cacheCreationTokens + cacheReadTokens`. If a request shows `inputTokens: 4000` but your prompt is 200K, the rest was served from cache.

## Minimum prefix sizes

Caching has a model-dependent minimum prefix. Below it, the marker is silently ignored — no error, just no cache:

| Model | Minimum |
|---|---:|
| Opus 4.7 / Opus 4.6 / Haiku 4.5 | 4096 tokens |
| Sonnet 4.6 | 2048 tokens |

If your "large" prompt is 1500 tokens, caching it on Opus 4.7 does nothing — count first.

```ts
const tokens = await brain.countTokens('', { system: longSystemPrompt })
if (tokens && tokens > 4096) {
  // Safe to cache.
}
```

`countTokens` returns `null` when the provider doesn't expose a count helper; the Anthropic provider always does.

## When NOT to cache

- **One-shot calls.** A single request gets nothing from caching but pays the write premium. Reserve caching for prefixes you'll send at least twice within the TTL.
- **Prompts that change from the start.** If the first 1K tokens differ per request, there's no reusable prefix. Adding `cache: true` only pays for nothing.
- **High-churn tool sets.** Tools render at position 0; adding/removing/reordering a tool invalidates the entire cache. If your app dynamically generates tools per user, you're going to have to invest more in cache design — out of scope for V1 (tools land in a later slice).

## When to use the 1-hour TTL

The default is 5 minutes; the SDK and Anthropic API support a 1-hour TTL at ~2× the write premium (vs 1.25×). The 1-hour TTL is worth it when:

- Your traffic is **bursty** — gaps longer than 5 minutes between requests.
- You're confident in **≥3 cache reads** per write (the break-even point at 2× write cost).

In V1, the framework exposes only the default 5-minute TTL. The 1-hour variant lands when an app needs it.

## Workflow integration

If you're orchestrating multiple inference calls inside a `@strav/workflow`, each step's `brain.chat` is its own cache write/read cycle — workflow doesn't compose the cache. For a fan-out + reuse pattern (e.g. classify-then-route), put the shared prefix into the first step's system prompt, then re-use that same system prompt in each downstream route handler. The cache hits across steps automatically.
