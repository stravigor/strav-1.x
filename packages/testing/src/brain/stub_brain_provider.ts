/**
 * Stub `BrainManager` wired as a `ServiceProvider` for tests that need
 * deterministic embeddings without dialing an actual brain backend.
 *
 * Extracted from `tests/e2e/m5-rag/`. The provider declares
 * `name: 'brain'` and `dependencies: ['config']`, matching the real
 * `BrainProvider`'s shape — `RagProvider` (which declares
 * `dependencies: ['config', 'brain']`) resolves the stub correctly
 * when both are in the provider list.
 *
 * ```ts
 * import { stubBrainProvider } from '@strav/testing/brain'
 *
 * const provider = stubBrainProvider({
 *   embed: (text) => bagOfWords(text), // returns number[]
 * })
 *
 * app.useProviders([
 *   new ConfigProvider({ ... }),
 *   new LoggerProvider(),
 *   new DatabaseProvider(),
 *   provider,             // ← stub registered here
 *   new RagProvider(),    // ← resolves the stub for its embed calls
 * ])
 * ```
 *
 * The `embed` callback is per-text — the helper maps over the input
 * array internally. Only `embed` is stubbed; other `BrainManager`
 * surface (`chat`, `stream`, `runWithTools`, …) throws when called.
 * V1 scope is rag-style tests; broader stubs land when a second
 * use case appears.
 */

import { BrainManager } from '@strav/brain'
import { type Application, ServiceProvider } from '@strav/kernel'

export interface StubBrainOptions {
  /**
   * Returns the embedding vector for a single text. The provider maps
   * the user's `embed` over `texts` internally to produce `number[][]`.
   */
  embed: (text: string) => number[]
  /** Model identifier surfaced on `embed` results. Default `'stub'`. */
  model?: string
}

export function stubBrainProvider(options: StubBrainOptions): ServiceProvider {
  const model = options.model ?? 'stub'
  const userEmbed = options.embed
  return new (class StubBrainProvider extends ServiceProvider {
    override readonly name = 'brain'
    override readonly dependencies = ['config']
    override register(app: Application): void {
      app.singleton(BrainManager, () => buildStub(userEmbed, model))
    }
  })()
}

function buildStub(
  embed: (text: string) => number[],
  model: string,
): BrainManager {
  const stub = {
    embed: async (texts: readonly string[]) => ({
      embeddings: texts.map(embed),
      model,
      usage: { inputTokens: 0 },
      raw: null,
    }),
  }
  return stub as unknown as BrainManager
}
