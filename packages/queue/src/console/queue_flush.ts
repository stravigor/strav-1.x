/**
 * `bun strav queue:flush [--queue=name] [--force]` — drop pending jobs.
 *
 * `DELETE FROM strav_jobs` (optionally filtered by queue name). Confirms
 * before running unless `--force` is set. Doesn't touch
 * `strav_failed_jobs` — the dead-letter table is separate and managed
 * via `queue:retry` / a separate operator-driven cleanup.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { PostgresDatabase } from '@strav/database'

export class QueueFlush extends Command {
  static signature = 'queue:flush {--queue=} {--force}'
  static description = 'Delete pending jobs (optionally filtered by --queue).'
  static providers = ['config', 'logger', 'database']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const queue = typeof flags.queue === 'string' && flags.queue.length > 0 ? flags.queue : null

    if (flags.force !== true) {
      const ok = await this.confirm(
        queue
          ? `Delete every pending job on queue "${queue}"? This is irreversible.`
          : 'Delete EVERY pending job across all queues? This is irreversible.',
      )
      if (!ok) {
        this.info('Aborted.')
        return ExitCode.Success
      }
    }

    const db = this.app.resolve(PostgresDatabase)
    const deleted = queue
      ? await db.execute(`DELETE FROM "strav_jobs" WHERE queue = $1`, [queue])
      : await db.execute(`DELETE FROM "strav_jobs"`)

    this.success(`Deleted ${deleted} pending job(s)${queue ? ` from queue "${queue}"` : ''}.`)
    return ExitCode.Success
  }
}
