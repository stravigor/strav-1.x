/**
 * `RagProvider` boot tests — verify the container wiring + defaults.
 * Uses a minimal Application stub since RagProvider only touches
 * the container + config repository.
 */

import { describe, expect, test } from 'bun:test'
import { BrainManager } from '@strav/brain'
import {
  Application,
  ConfigError,
  ConfigRepository,
  ServiceProvider,
} from '@strav/kernel'
import { MemoryDriver } from '../src/drivers/memory_driver.ts'
import { RagManager } from '../src/rag_manager.ts'
import { RagProvider } from '../src/rag_provider.ts'

/** Minimal config provider — registers ConfigRepository with the supplied object. */
class StubConfigProvider extends ServiceProvider {
  override readonly name = 'config'
  constructor(private readonly config: Record<string, unknown>) {
    super()
  }
  override register(app: Application): void {
    const cfg = this.config
    app.singleton(ConfigRepository, () => {
      const repo = new ConfigRepository()
      for (const [k, v] of Object.entries(cfg)) {
        repo.set(k, v as never)
      }
      return repo
    })
  }
}

/** Stub brain provider — registers a no-op BrainManager. */
class StubBrainProvider extends ServiceProvider {
  override readonly name = 'brain'
  override readonly dependencies = ['config']
  override register(app: Application): void {
    app.singleton(BrainManager, () => ({} as unknown as BrainManager))
  }
}

async function boot(config: Record<string, unknown>): Promise<Application> {
  const app = new Application()
  return app.useProviders([
    new StubConfigProvider(config),
    new StubBrainProvider(),
    new RagProvider(),
  ])
}

describe('RagProvider — defaults', () => {
  test('no config.rag at all → boots with memory driver default', async () => {
    const app = await boot({})
    await app.start()
    const manager = app.resolve(RagManager)
    expect(manager.config.default).toBe('memory')
    expect(manager.store()).toBeInstanceOf(MemoryDriver)
    await app.shutdown()
  })

  test('config.rag.stores without `default` picks the first key', async () => {
    const app = await boot({
      rag: { stores: { custom_memory: { driver: 'memory' } } },
    })
    await app.start()
    const manager = app.resolve(RagManager)
    expect(manager.config.default).toBe('custom_memory')
    await app.shutdown()
  })

  test('default referencing a missing store throws ConfigError', async () => {
    const app = await boot({
      rag: { default: 'missing', stores: { memory: { driver: 'memory' } } },
    })
    await expect(app.start()).rejects.toBeInstanceOf(ConfigError)
  })

  test('pgvector without PostgresDatabase registered → boot ConfigError', async () => {
    const app = await boot({
      rag: { default: 'pg', stores: { pg: { driver: 'pgvector' } } },
    })
    await expect(app.start()).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('RagProvider — config passthrough', () => {
  test('honors prefix, embedding, chunking config', async () => {
    const app = await boot({
      rag: {
        default: 'memory',
        prefix: 'app_',
        embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 },
        chunking: { strategy: 'fixed', chunkSize: 256, overlap: 32 },
        stores: { memory: { driver: 'memory' } },
      },
    })
    await app.start()
    const manager = app.resolve(RagManager)
    expect(manager.config.prefix).toBe('app_')
    expect(manager.config.embedding.dimension).toBe(1536)
    expect(manager.config.chunking).toEqual({
      strategy: 'fixed',
      chunkSize: 256,
      overlap: 32,
    })
    await app.shutdown()
  })
})
