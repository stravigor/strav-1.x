/**
 * `bun strav scheduler:run <name>` — force-dispatch one named entry on demand.
 *
 * Bypasses the cron expression. When the entry was registered with
 * `oneServer: true`, the advisory lock + run-tracking row still apply,
 * so two `scheduler:run` invocations from different machines can't
 * double-dispatch.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { Scheduler } from '../scheduler.ts'

export class SchedulerRun extends Command {
  static signature = 'scheduler:run {name}'
  static description = 'Force-run one named schedule entry.'

  override async execute({ args }: ExecuteArgs): Promise<number> {
    const name = args.name
    if (!name) return ExitCode.UsageError // unreachable: bindArgv already enforced

    const scheduler = this.app.resolve(Scheduler)
    try {
      await scheduler.runEntry(name)
    } catch (err) {
      this.error((err as Error).message)
      return ExitCode.UsageError
    }
    this.success(`Dispatched "${name}".`)
    return ExitCode.Success
  }
}
