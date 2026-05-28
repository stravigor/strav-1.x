/**
 * `bun strav migrate:status` — table of applied + pending migrations.
 *
 * Applied rows are sorted by `applied_at`; pending rows follow in
 * alphabetical (i.e., execution) order. The output is purely informational
 * — never mutates the DB.
 */

import { Command, ExitCode } from '@strav/cli'
import { resolveMigrationRunner } from '../migrations/index.ts'

export class MigrateStatus extends Command {
  static signature = 'migrate:status'
  static description = 'List applied + pending migrations.'
  static providers = ['config', 'logger', 'database']

  override async execute(): Promise<number> {
    const runner = await resolveMigrationRunner(this.app)
    const status = await runner.status()

    if (status.applied.length === 0 && status.pending.length === 0) {
      this.info('No migrations registered.')
      return ExitCode.Success
    }

    const rows: string[][] = []
    for (const row of status.applied) {
      rows.push([row.name, 'applied', String(row.batch), row.applied_at.toISOString()])
    }
    for (const name of status.pending) {
      rows.push([name, 'pending', '-', '-'])
    }
    this.table(['Name', 'Status', 'Batch', 'Applied at'], rows)
    return ExitCode.Success
  }
}
