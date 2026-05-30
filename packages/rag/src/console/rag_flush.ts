/**
 * `bun strav rag:flush <collection> [--store=name] [--force]` —
 * drop every vector in a collection on the active (or named)
 * store.
 *
 * Use cases:
 *
 *   - Wiping a corrupted index before re-ingest.
 *   - Cleaning up a dev / staging environment.
 *   - Recovering after a dimension / model change.
 *
 * The command confirms before running unless `--force` is set.
 * Doesn't touch the source data — apps run their own re-ingest
 * afterward, typically via `retrievable` repo's `reindexAll()`.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { RagManager } from '../rag_manager.ts'

export class RagFlush extends Command {
  static signature = 'rag:flush {collection} {--store=} {--force}'
  static description =
    'Delete every vector in a collection (on the active or --store= named store).'
  static providers = ['config', 'logger', 'brain', 'rag']

  override async execute({ args, flags }: ExecuteArgs): Promise<number> {
    const collection = args.collection as string
    const storeName =
      typeof flags.store === 'string' && flags.store.length > 0 ? flags.store : undefined

    const manager = this.app.resolve(RagManager)
    const fullCollection = manager.collectionName(collection)
    const storeLabel = storeName ?? manager.config.default

    if (flags.force !== true) {
      const ok = await this.confirm(
        `Delete every vector in collection "${fullCollection}" on store "${storeLabel}"? This is irreversible.`,
      )
      if (!ok) {
        this.info('Aborted.')
        return ExitCode.Success
      }
    }

    await manager.store(storeName).flush(fullCollection)
    this.success(`Flushed collection "${fullCollection}" on store "${storeLabel}".`)
    return ExitCode.Success
  }
}
