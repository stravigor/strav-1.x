/**
 * `RagProvider` — `ServiceProvider` that wires `RagManager` into
 * the container from `config.rag`.
 *
 * Eager construction at boot — a malformed config or a missing
 * pgvector dependency should fail before the first call hits.
 * Apps register `BrainProvider` and `DatabaseProvider` (when
 * pgvector is in the store list) before this one; the
 * `dependencies` array makes the order explicit.
 *
 * Config defaults: if `config.rag` is absent entirely, the
 * provider boots a sensible in-memory setup so apps can try
 * `rag.ingest()` / `rag.retrieve()` in dev without configuration
 * — the memory driver is registered as the default store and a
 * `recursive` chunker is configured. Production apps override
 * via a real `config/rag.ts`.
 */

// biome-ignore lint/style/useImportType: BrainManager value import for c.resolve.
import { BrainManager } from '@strav/brain'
// biome-ignore lint/style/useImportType: PostgresDatabase value import — required when any pgvector store is configured. Loaded conditionally below.
import { PostgresDatabase } from '@strav/database'
import { type Application, ConfigError, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { RagManager, type RagManagerOptions } from './rag_manager.ts'
import { RetrievableRegistry } from './retrievable_registry.ts'
import type { RagConfig } from './types.ts'

export class RagProvider extends ServiceProvider {
  override readonly name = 'rag'
  override readonly dependencies = ['config', 'brain']

  override register(app: Application): void {
    app.singleton(RetrievableRegistry, () => new RetrievableRegistry())
    app.singleton(RagManager, (c) => {
      const raw = c.resolve(ConfigRepository).get('rag') as Partial<RagConfig> | undefined
      const config = applyDefaults(raw)

      const brain = c.resolve(BrainManager)
      const opts: RagManagerOptions = { config, brain }

      // Only resolve the database when at least one store needs it.
      const needsDb = Object.values(config.stores).some((s) => s.driver === 'pgvector')
      if (needsDb) {
        try {
          opts.db = c.resolve(PostgresDatabase)
        } catch (cause) {
          throw new ConfigError(
            'RagProvider: at least one store uses `driver: "pgvector"` but PostgresDatabase is not registered. Register DatabaseProvider before RagProvider.',
            { cause },
          )
        }
      }
      return new RagManager(opts)
    })
  }

  override boot(app: Application): void {
    // Force-resolve so config errors surface at boot, not on first call.
    app.resolve(RagManager)
  }
}

/**
 * Fill in defaults for omitted config fields. Apps with no
 * `config/rag.ts` at all get a working in-memory setup.
 */
function applyDefaults(raw: Partial<RagConfig> | undefined): RagConfig {
  const config: Partial<RagConfig> = raw ?? {}
  const stores = config.stores ?? { memory: { driver: 'memory' } }
  const def = config.default ?? Object.keys(stores)[0] ?? 'memory'
  if (!stores[def]) {
    throw new ConfigError(
      `RagProvider: default store "${def}" is not declared in config.rag.stores.`,
    )
  }
  return {
    default: def,
    ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
    embedding: config.embedding ?? {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
    },
    chunking: config.chunking ?? {
      strategy: 'recursive',
      chunkSize: 512,
      overlap: 64,
    },
    stores,
  }
}
