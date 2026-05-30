/**
 * CLI command tests. Mirror the @strav/queue console test pattern:
 * a memory stream captures stdout, a Command instance handles a
 * crafted CommandContext, exit code + output are asserted.
 */

import { describe, expect, test } from 'bun:test'
import type { BrainManager } from '@strav/brain'
import { Application, type CommandContext, ConsoleOutput } from '@strav/kernel'
import { RagFlush } from '../src/console/rag_flush.ts'
import { RagList } from '../src/console/rag_list.ts'
import type { MemoryDriver } from '../src/drivers/memory/memory_driver.ts'
import { RagManager } from '../src/rag_manager.ts'
import type { RagConfig } from '../src/types.ts'

class MemStream {
  chunks: string[] = []
  write(c: string): boolean {
    this.chunks.push(c)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

function buildCtx(app: Application): {
  ctx: (args?: readonly string[], flags?: Record<string, string | boolean>) => CommandContext
  stdout: MemStream
} {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx = (
    args: readonly string[] = [],
    flags: Record<string, string | boolean> = {},
  ): CommandContext => ({
    args,
    flags,
    out,
    app,
  })
  return { ctx, stdout }
}

function makeApp(config: RagConfig): Application {
  const app = new Application()
  const brain = {
    embed: async () => ({
      embeddings: [[1, 0]],
      model: 'stub',
      usage: { inputTokens: 0 },
      raw: null,
    }),
  } as unknown as BrainManager
  const manager = new RagManager({ config, brain })
  app.singleton(RagManager, () => manager)
  return app
}

const baseConfig: RagConfig = {
  default: 'mem',
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 2 },
  chunking: { strategy: 'recursive', chunkSize: 256, overlap: 32 },
  stores: { mem: { driver: 'memory' } },
}

// ─── rag:list ────────────────────────────────────────────────────────────

describe('rag:list', () => {
  test('prints default + stores + embedding + chunking', async () => {
    const app = makeApp(baseConfig)
    const env = buildCtx(app)
    const exit = await new RagList().handle(env.ctx())
    expect(exit).toBe(0)
    const text = env.stdout.text()
    expect(text).toContain('Default store: mem')
    expect(text).toContain('mem (default)')
    expect(text).toContain('driver=memory')
    expect(text).toContain('text-embedding-3-small')
    expect(text).toContain('strategy:  recursive')
  })

  test('prints prefix when configured', async () => {
    const app = makeApp({ ...baseConfig, prefix: 'app_' })
    const env = buildCtx(app)
    await new RagList().handle(env.ctx())
    expect(env.stdout.text()).toContain('Collection prefix: app_')
  })
})

// ─── rag:flush ───────────────────────────────────────────────────────────

describe('rag:flush', () => {
  test('--force flushes without prompting', async () => {
    const app = makeApp(baseConfig)
    const manager = app.resolve(RagManager)
    await manager.createCollection('articles')
    const driver = manager.store() as MemoryDriver
    await driver.upsert('articles', [{ id: 'v_1', content: 'a', embedding: [1, 0], metadata: {} }])

    const env = buildCtx(app)
    const exit = await new RagFlush().handle(env.ctx(['articles'], { force: true }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Flushed collection "articles"')
    const result = await driver.query('articles', [1, 0])
    expect(result.matches).toEqual([])
  })

  test('applies the configured prefix', async () => {
    const app = makeApp({ ...baseConfig, prefix: 'tenant_42_' })
    const manager = app.resolve(RagManager)
    await manager.createCollection('articles')

    const env = buildCtx(app)
    await new RagFlush().handle(env.ctx(['articles'], { force: true }))
    expect(env.stdout.text()).toContain('"tenant_42_articles"')
  })

  test('--store= routes to a named store', async () => {
    const app = makeApp({
      ...baseConfig,
      stores: { mem: { driver: 'memory' }, alt: { driver: 'memory' } },
    })
    const manager = app.resolve(RagManager)
    await manager.createCollection('articles', { store: 'alt' })

    const env = buildCtx(app)
    const exit = await new RagFlush().handle(env.ctx(['articles'], { force: true, store: 'alt' }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('on store "alt"')
  })
})
