/**
 * `bun strav rag:reindex {name?} [--all] [--batch=100]` —
 * walk a registered repository and re-vectorize every row.
 *
 * Apps register repos at boot:
 *
 *   const registry = app.resolve(RetrievableRegistry)
 *   registry.register('articles', ArticleRepository)
 *
 * Then:
 *
 *   bun strav rag:reindex articles          # one repo
 *   bun strav rag:reindex --all             # every registered repo
 *
 * The repo class must implement `reindexAll(batchSize?)` — the
 * `retrievable()` mixin already does. Batch size defaults to 100;
 * apps hitting embedding rate limits drop it lower.
 *
 * Long-running on large corpora — apps that need cron-driven or
 * queued re-index typically ship a custom command pointing at the
 * same `reindexAll` method.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { RagError } from '../rag_error.ts'
import { RetrievableRegistry } from '../retrievable_registry.ts'

export class RagReindex extends Command {
  static signature = 'rag:reindex {name?} {--all} {--batch=100}'
  static description =
    'Re-vectorize one registered retrievable repository (or every one with --all).'
  static providers = ['config', 'logger', 'brain', 'rag', 'database']

  override async execute({ args, flags }: ExecuteArgs): Promise<number> {
    const registry = this.app.resolve(RetrievableRegistry)
    const batchSize = parseBatch(flags.batch)

    if (flags.all === true) {
      const names = registry.names()
      if (names.length === 0) {
        this.warn(
          'No retrievables registered. Call `registry.register(name, Repo)` from a service provider first.',
        )
        return ExitCode.Success
      }
      let total = 0
      for (const name of names) {
        const processed = await this.reindexOne(registry, name, batchSize)
        total += processed
      }
      this.success(
        `Re-indexed ${total} rows across ${names.length} repositor${names.length === 1 ? 'y' : 'ies'}.`,
      )
      return ExitCode.Success
    }

    const name = args.name
    if (typeof name !== 'string' || name.length === 0) {
      this.error(
        'rag:reindex requires a repository name, or --all to re-index every registered repository.',
      )
      this.info(`Registered: ${registry.names().join(', ') || '(none)'}`)
      return ExitCode.UsageError
    }

    try {
      const processed = await this.reindexOne(registry, name, batchSize)
      this.success(`Re-indexed ${processed} rows in "${name}".`)
      return ExitCode.Success
    } catch (err) {
      if (err instanceof RagError) {
        this.error(err.message)
        this.info(`Registered: ${registry.names().join(', ') || '(none)'}`)
        return ExitCode.GenericFailure
      }
      throw err
    }
  }

  private async reindexOne(
    registry: RetrievableRegistry,
    name: string,
    batchSize: number,
  ): Promise<number> {
    this.info(`Re-indexing "${name}"…`)
    const repo = this.app.resolve(registry.resolve(name))
    const processed = await repo.reindexAll(batchSize)
    this.info(`  ${processed} rows.`)
    return processed
  }
}

function parseBatch(raw: unknown): number {
  if (typeof raw === 'number' && raw > 0) return Math.floor(raw)
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 100
}
