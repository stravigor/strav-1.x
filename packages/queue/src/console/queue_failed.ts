/**
 * `bun strav queue:failed` — list rows in the dead-letter table.
 *
 * Reads `strav_failed_jobs` directly via the bound `Database`. The
 * Worker moves terminal failures here (atomic INSERT + DELETE from
 * `strav_jobs`); this command surfaces them for triage.
 */

import { Command, ExitCode } from '@strav/cli'
import { PostgresDatabase } from '@strav/database'

interface FailedRow {
  id: string
  queue: string
  job_name: string
  attempts: number
  failed_at: Date | string
  exception: string
}

export class QueueFailed extends Command {
  static signature = 'queue:failed'
  static description = 'List jobs in the dead-letter table.'
  static providers = ['config', 'logger', 'database']

  override async execute(): Promise<number> {
    const db = this.app.resolve(PostgresDatabase)
    const rows = await db.query<FailedRow>(
      `SELECT id, queue, job_name, attempts, failed_at, exception
         FROM "strav_failed_jobs"
         ORDER BY failed_at DESC`,
    )

    if (rows.length === 0) {
      this.info('No failed jobs.')
      return ExitCode.Success
    }

    this.table(
      ['ID', 'Queue', 'Job', 'Attempts', 'Failed at', 'Error'],
      rows.map((r) => [
        r.id,
        r.queue,
        r.job_name,
        String(r.attempts),
        (r.failed_at instanceof Date ? r.failed_at : new Date(r.failed_at)).toISOString(),
        firstLine(r.exception),
      ]),
    )
    return ExitCode.Success
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}
