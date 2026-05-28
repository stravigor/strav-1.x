/**
 * `bun strav scheduler:list` — table of every registered scheduled entry.
 *
 * Read-only / pure introspection — never dispatches.
 */

import { Command, ExitCode } from '@strav/cli'
import { Scheduler } from '../scheduler.ts'

export class SchedulerList extends Command {
  static signature = 'scheduler:list'
  static description = 'List registered scheduler entries.'

  override execute(): number {
    const scheduler = this.app.resolve(Scheduler)
    const entries = scheduler.all()
    if (entries.length === 0) {
      this.info('No schedules registered.')
      return ExitCode.Success
    }
    this.table(
      ['Name', 'Cron', 'Job', 'OneServer'],
      entries.map((e) => [e.name, e.cron.expression, e.job.jobName, e.oneServer ? 'yes' : 'no']),
    )
    return ExitCode.Success
  }
}
