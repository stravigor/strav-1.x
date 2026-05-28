/**
 * `bun strav scheduler:work` — run the minute-tick scheduler loop.
 *
 * Long-running; SIGINT / SIGTERM aborts the loop, which (per Scheduler's
 * semantics) returns within one tick.
 */

import { Command, ExitCode } from '@strav/cli'
import { Scheduler } from '../scheduler.ts'

export class SchedulerWork extends Command {
  static signature = 'scheduler:work'
  static description = 'Run the scheduler tick loop until interrupted.'

  override async execute(): Promise<number> {
    const scheduler = this.app.resolve(Scheduler)
    const controller = new AbortController()
    const sigint = () => controller.abort()
    const sigterm = () => controller.abort()
    process.once('SIGINT', sigint)
    process.once('SIGTERM', sigterm)

    this.info(`Scheduler started (${scheduler.all().length} entries).`)
    try {
      await scheduler.run(controller.signal)
      return ExitCode.Success
    } finally {
      process.off('SIGINT', sigint)
      process.off('SIGTERM', sigterm)
    }
  }
}
