/**
 * `bun strav queue:retry <id>` or `--all` — re-enqueue failed jobs.
 *
 * Copies the failed row(s) back into `strav_jobs` (attempts reset to 0,
 * available_at = now()) and deletes them from `strav_failed_jobs` — all
 * inside one transaction so a crash mid-move can't lose rows or
 * double-enqueue.
 *
 * `<id>` re-enqueues exactly one job; `--all` re-enqueues every row in
 * the dead-letter table. Without either, the command errors out with a
 * usage message.
 */

import { Command, type ExecuteArgs, ExitCode, UsageError } from '@strav/cli'
import { PostgresDatabase } from '@strav/database'
import { ulid } from '@strav/kernel'

interface FailedRow {
  id: string
  queue: string
  job_name: string
  payload: unknown
}

export class QueueRetry extends Command {
  static signature = 'queue:retry {id?} {--all}'
  static description = 'Re-enqueue a failed job by id, or every failed job with --all.'
  static providers = ['config', 'logger', 'database']

  override async execute({ args, flags }: ExecuteArgs): Promise<number> {
    const all = flags.all === true
    const id = args.id
    if (!all && (id === undefined || id.length === 0)) {
      throw new UsageError('queue:retry needs an <id> or the --all flag')
    }
    if (all && id !== undefined && id.length > 0) {
      throw new UsageError('queue:retry: pass an <id> OR --all, not both')
    }

    const db = this.app.resolve(PostgresDatabase)
    const moved = await db.transaction(async (tx) => {
      const rows = all
        ? await tx.query<FailedRow>(`SELECT id, queue, job_name, payload FROM "strav_failed_jobs"`)
        : await tx.query<FailedRow>(
            `SELECT id, queue, job_name, payload FROM "strav_failed_jobs" WHERE id = $1`,
            [id],
          )
      for (const row of rows) {
        await tx.execute(
          `INSERT INTO "strav_jobs" (id, queue, job_name, payload, attempts, max_attempts, available_at, reserved_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 0, 3, now(), NULL, now(), now())`,
          [ulid(), row.queue, row.job_name, row.payload],
        )
        await tx.execute(`DELETE FROM "strav_failed_jobs" WHERE id = $1`, [row.id])
      }
      return rows
    })

    if (moved.length === 0) {
      if (all) this.info('No failed jobs to retry.')
      else this.warn(`No failed job with id "${id}".`)
      return ExitCode.Success
    }
    this.success(`Re-enqueued ${moved.length} job(s).`)
    for (const row of moved) this.line(`  ↻ ${row.id}  ${row.job_name}`)
    return ExitCode.Success
  }
}
