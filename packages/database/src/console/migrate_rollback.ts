/**
 * `bun strav migrate:rollback [--batch=N|all]` — roll back the most-
 * recently-applied batch (or N batches, or every batch).
 *
 * `MigrationRunner.rollback()` undoes one batch per call. This command
 * loops N times (default 1). `--batch=all` keeps rolling back until the
 * runner reports an empty batch (every applied migration is reversed).
 *
 * The runner's per-migration-transaction semantics still apply — a
 * partial rollback leaves the tracking table consistent with what
 * actually ran.
 */

import { Command, type ExecuteArgs, ExitCode, UsageError } from '@strav/cli'
import { resolveMigrationRunner } from '../migrations/index.ts'

export class MigrateRollback extends Command {
  static signature = 'migrate:rollback {--batch=1}'
  static description = 'Roll back the last batch (or --batch=N batches, or --batch=all).'
  static providers = ['config', 'logger', 'database']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const raw = flags.batch
    if (typeof raw !== 'string') {
      throw new UsageError('flag --batch requires a value (a positive integer or "all")')
    }
    const rollbackAll = raw === 'all'
    const count = rollbackAll ? Number.POSITIVE_INFINITY : Number.parseInt(raw, 10)
    if (!rollbackAll && (!Number.isInteger(count) || count < 1)) {
      throw new UsageError(`--batch must be a positive integer or "all" (got "${raw}")`)
    }

    const runner = await resolveMigrationRunner(this.app)
    let totalRolledBack = 0
    let batchesUndone = 0
    while (batchesUndone < count) {
      const result = await runner.rollback()
      if (result.batch === 0) break // nothing more to undo
      this.success(`Rolled back batch ${result.batch} (${result.rolled_back.length} migration(s)).`)
      for (const name of result.rolled_back) this.line(`  ✗ ${name}`)
      totalRolledBack += result.rolled_back.length
      batchesUndone++
    }

    if (totalRolledBack === 0) {
      this.info('Nothing to roll back.')
    } else {
      this.info(`Rolled back ${totalRolledBack} migration(s) across ${batchesUndone} batch(es).`)
    }
    return ExitCode.Success
  }
}
