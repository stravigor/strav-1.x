# Getting started with @strav/brain

This guide takes a fresh Strav app from "no AI" to "controller calling an LLM with full DI" in under five minutes. It assumes you have a Strav 1.x app booting via `bin/strav.ts` + `ServiceProvider`s — if not, see the [`@strav/kernel` getting-started](../../kernel/README.md) first.

## 1. Get an API key

Sign up for an Anthropic API key at [console.anthropic.com](https://console.anthropic.com). Drop it in `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-…
```

> Don't commit `.env`. The app reads it via `env('ANTHROPIC_API_KEY')` at boot.

## 2. Configure the brain

Create `config/brain.ts`:

```ts
import { env } from '@strav/kernel'
import type { BrainConfigShape } from '@strav/brain'

export default {
  default: 'anthropic',
  providers: {
    anthropic: {
      driver: 'anthropic',
      apiKey: env('ANTHROPIC_API_KEY'),
      defaultModel: 'claude-opus-4-7',
      defaultMaxTokens: 4096,
    },
  },
} satisfies BrainConfigShape
```

The `providers` map is keyed by provider name (not driver name) — apps can have multiple Anthropic configs (e.g. one for the user-facing chat and one for a background summarizer) and route between them via `options.provider`.

## 3. Wire `BrainProvider`

In `bootstrap/providers.ts`, alongside the rest of your providers:

```ts
import { BrainProvider } from '@strav/brain'
import brainConfig from '../config/brain.ts'

export function providers(): ServiceProvider[] {
  return [
    new ConfigProvider({
      brain: brainConfig,
      // …other config sections
    }),
    new LoggerProvider(),
    new BrainProvider(),
  ]
}
```

`BrainProvider` eager-resolves at boot, so a missing API key or unknown driver fails at startup instead of at the first request.

## 4. Inject `BrainManager`

Anywhere you can `@inject()`:

```ts
import { inject } from '@strav/kernel'
import { BrainManager } from '@strav/brain'

@inject()
export class SummaryService {
  constructor(private readonly brain: BrainManager) {}

  async summarize(article: string): Promise<string> {
    const { text, usage } = await this.brain.chat([
      { role: 'user', content: `Summarize in two sentences:\n\n${article}` },
    ], {
      tier: 'balanced',   // → claude-sonnet-4-6
      maxTokens: 200,
    })
    console.log(`Used ${usage.inputTokens} in + ${usage.outputTokens} out`)
    return text
  }
}
```

That's it for one-shot calls. The rest of this guide covers the surfaces you'll reach for as soon as the app does anything interesting.

## Picking a model

Most apps shouldn't hardcode model IDs in service code — config drift will leave you with old IDs in production. Two patterns:

**Per-config default.** Set `defaultModel` on the provider config; service code calls `brain.chat(...)` without a `model`. Useful when one service uses one model.

**Tier sugar.** Pass `{ tier: 'fast' | 'balanced' | 'powerful' }`. The framework defaults map to current models (Haiku 4.5 / Sonnet 4.6 / Opus 4.7); apps remap via `config.brain.tiers` if they want to point `fast` at a different model:

```ts
{
  default: 'anthropic',
  providers: { anthropic: { … } },
  tiers: {
    fast: 'claude-haiku-4-5',
    balanced: 'claude-sonnet-4-6',
    powerful: 'claude-opus-4-7',
  },
}
```

## Streaming

For chat UIs and any response >~16K tokens, stream:

```ts
async function handleChat(ctx: HttpContext, brain: BrainManager) {
  const stream = brain.stream(ctx.request.body.prompt, {
    tier: 'powerful',
    maxTokens: 64000,
    thinking: 'adaptive',
  })

  return new Response(
    new ReadableStream({
      async start(controller) {
        for await (const event of stream) {
          if (event.type === 'text') {
            controller.enqueue(new TextEncoder().encode(event.delta))
          }
        }
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
}
```

The stream yields `text` events per delta and a final `stop` event with `stopReason` + `usage`. The `usage.cacheReadTokens` field tells you whether prompt caching paid off — `0` means everything was full-price.

## Thinking + effort

Opt into Claude's adaptive thinking when the task benefits — multi-step reasoning, hard code review, planning:

```ts
const { text } = await brain.chat(prompt, {
  thinking: 'adaptive',
  effort: 'high',   // or 'xhigh' / 'max' for harder problems; 'medium' / 'low' for fast/cheap
})
```

`effort` defaults to the provider's pick. On Opus 4.7, the SDK's default is `high`; `xhigh` is the sweet spot for coding/agentic work, `max` for the hardest problems. See the Anthropic docs for the cost-vs-quality tradeoffs.

## Errors

Every call can throw. The provider's native error propagates verbatim — apps that need provider-specific recovery do `instanceof Anthropic.RateLimitError` etc. The framework wraps boot-time invariant failures in `BrainError` (`brain.error`, status 500).

```ts
import Anthropic from '@anthropic-ai/sdk'
import { BrainError } from '@strav/brain'

try {
  const { text } = await brain.chat(prompt)
  return ctx.response.ok({ text })
} catch (err) {
  if (err instanceof Anthropic.RateLimitError) {
    return ctx.response.tooManyRequests({ retryAfter: 30 })
  }
  if (err instanceof BrainError) {
    return ctx.response.serviceUnavailable({ message: err.message })
  }
  throw err
}
```

## Where to next

- [`prompt-caching.md`](./prompt-caching.md) — when to cache, how to verify it's working.
- [`threads.md`](./threads.md) — multi-turn conversations with persistence.
- API reference at [`../api.md`](../api.md) for every exported symbol.
