/**
 * RetrievableRegistry + rag:reindex command. Mirrors the
 * `console.test.ts` harness so the command runs through `handle()`
 * with a real Application + signature binding.
 */

import { describe, expect, test } from 'bun:test'
import type { BrainManager } from '@strav/brain'
import { Application, type CommandContext, ConsoleOutput } from '@strav/kernel'
import { RagReindex } from '../src/console/rag_reindex.ts'
import { RagManager } from '../src/rag_manager.ts'
import { RetrievableRegistry } from '../src/retrievable_registry.ts'
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
  stderr: MemStream
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
  ): CommandContext => ({ args, flags, out, app })
  return { ctx, stdout, stderr }
}

const baseConfig: RagConfig = {
  default: 'mem',
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 2 },
  chunking: { strategy: 'recursive', chunkSize: 64, overlap: 0 },
  stores: { mem: { driver: 'memory' } },
}

class StubRepo {
  static instances: StubRepo[] = []
  calls: number[] = []
  constructor(
    public readonly name: string,
    private readonly rowCount: number,
  ) {
    StubRepo.instances.push(this)
  }
  async reindexAll(batchSize?: number): Promise<number> {
    this.calls.push(batchSize ?? -1)
    return this.rowCount
  }
}

function makeApp(): Application {
  StubRepo.instances = []
  const app = new Application()
  const brain = {
    embed: async () => ({
      embeddings: [[1, 0]],
      model: 'stub',
      usage: { inputTokens: 0 },
      raw: null,
    }),
  } as unknown as BrainManager
  const manager = new RagManager({ config: baseConfig, brain })
  app.singleton(RagManager, () => manager)
  app.singleton(RetrievableRegistry, () => new RetrievableRegistry())
  return app
}

// ─── RetrievableRegistry ─────────────────────────────────────────────────

describe('RetrievableRegistry', () => {
  test('register + names + resolve round-trip', () => {
    const reg = new RetrievableRegistry()
    class A {
      async reindexAll() {
        return 0
      }
    }
    class B {
      async reindexAll() {
        return 0
      }
    }
    reg.register('articles', A)
    reg.register('comments', B)
    expect(reg.names()).toEqual(['articles', 'comments'])
    expect(reg.resolve('articles')).toBe(A)
  })

  test('resolve throws when unregistered', () => {
    const reg = new RetrievableRegistry()
    expect(() => reg.resolve('missing')).toThrow(/no retrievable registered/i)
  })
})

// ─── rag:reindex ─────────────────────────────────────────────────────────

describe('rag:reindex', () => {
  test('reindexes one registered repository with default batch=100', async () => {
    const app = makeApp()
    class Articles extends StubRepo {
      constructor() {
        super('articles', 42)
      }
    }
    app.singleton(Articles, () => new Articles())
    app.resolve(RetrievableRegistry).register('articles', Articles)

    const env = buildCtx(app)
    const exit = await new RagReindex().handle(env.ctx(['articles']))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Re-indexed 42 rows in "articles"')
    expect(StubRepo.instances[0]?.calls).toEqual([100])
  })

  test('--batch=N forwards through to reindexAll', async () => {
    const app = makeApp()
    class Articles extends StubRepo {
      constructor() {
        super('articles', 5)
      }
    }
    app.singleton(Articles, () => new Articles())
    app.resolve(RetrievableRegistry).register('articles', Articles)

    const env = buildCtx(app)
    await new RagReindex().handle(env.ctx(['articles'], { batch: '25' }))
    expect(StubRepo.instances[0]?.calls).toEqual([25])
  })

  test('--all walks every registered repository', async () => {
    const app = makeApp()
    class Articles extends StubRepo {
      constructor() {
        super('articles', 3)
      }
    }
    class Comments extends StubRepo {
      constructor() {
        super('comments', 7)
      }
    }
    app.singleton(Articles, () => new Articles())
    app.singleton(Comments, () => new Comments())
    const registry = app.resolve(RetrievableRegistry)
    registry.register('articles', Articles)
    registry.register('comments', Comments)

    const env = buildCtx(app)
    const exit = await new RagReindex().handle(env.ctx([], { all: true }))
    expect(exit).toBe(0)
    const out = env.stdout.text()
    expect(out).toContain('Re-indexing "articles"')
    expect(out).toContain('Re-indexing "comments"')
    expect(out).toContain('Re-indexed 10 rows across 2 repositories')
  })

  test('--all with no registered repos exits success with a warning', async () => {
    const app = makeApp()
    const env = buildCtx(app)
    const exit = await new RagReindex().handle(env.ctx([], { all: true }))
    expect(exit).toBe(0)
    expect(env.stderr.text() + env.stdout.text()).toContain('No retrievables registered')
  })

  test('no name + no --all exits with usage error', async () => {
    const app = makeApp()
    const env = buildCtx(app)
    const exit = await new RagReindex().handle(env.ctx([]))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toMatch(/requires a repository name|--all/i)
  })

  test('unknown name exits with failure and lists registered names', async () => {
    const app = makeApp()
    class Articles extends StubRepo {
      constructor() {
        super('articles', 3)
      }
    }
    app.singleton(Articles, () => new Articles())
    app.resolve(RetrievableRegistry).register('articles', Articles)

    const env = buildCtx(app)
    const exit = await new RagReindex().handle(env.ctx(['missing']))
    expect(exit).toBe(1)
    const out = env.stdout.text() + env.stderr.text()
    expect(out).toContain('no retrievable registered')
    expect(out).toContain('articles')
  })
})
