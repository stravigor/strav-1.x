/**
 * `QueueConsoleProvider` — declares the queue + scheduler console commands.
 *
 * Apps add it to `bootstrap/providers.ts` alongside whatever provider binds
 * `Worker` + `Scheduler` (apps wire those — see `docs/queue/guides/console.md`).
 *
 * The provider doesn't bind Worker/Scheduler itself because their
 * construction is app-specific (queue names, registered jobs, scheduler
 * entries) — too much variance for a sensible default.
 */

import { ConsoleProvider } from '@strav/cli'
import { QueueFailed } from './queue_failed.ts'
import { QueueFlush } from './queue_flush.ts'
import { QueueRetry } from './queue_retry.ts'
import { QueueWork } from './queue_work.ts'
import { SchedulerList } from './scheduler_list.ts'
import { SchedulerRun } from './scheduler_run.ts'
import { SchedulerWork } from './scheduler_work.ts'

export class QueueConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.queue'
  override readonly commands = [
    QueueWork,
    QueueFailed,
    QueueRetry,
    QueueFlush,
    SchedulerWork,
    SchedulerList,
    SchedulerRun,
  ] as const
}
