/**
 * `bun strav queue:work [--max=N]` — drain jobs forever (or up to N).
 *
 * Resolves the container-bound `Worker`. Apps construct the `Worker` in
 * their provider (it needs `db`, `registry`, `container`, plus the
 * `queues` slice config) — the command just drives it.
 *
 * Signal handling: registers `SIGINT` + `SIGTERM` listeners that abort
 * the worker's loop. The Worker's own graceful-shutdown semantics
 * (drain in-flight jobs, release SKIP LOCKED rows) handle the rest.
 *
 * `--max=N` exits after N completed jobs — useful for hosted runtimes
 * (Render workers, supervised tasks) that prefer "exit cleanly so the
 * supervisor restarts you" over an unbounded loop. When N is set we
 * loop on `processOne()` so we can count cleanly; otherwise we hand
 * off to `worker.run(signal)`.
 */

import { Command, type ExecuteArgs, ExitCode, UsageError } from '@strav/cli'
import { Worker } from '../worker.ts'

export class QueueWork extends Command {
  static signature = 'queue:work {--queue=default} {--max=}'
  static description = 'Run a queue worker until interrupted (or --max=N jobs).'
  // Boot the full default list — the Worker pulls Database, JobRegistry,
  // Logger, and any app-registered services through the container at
  // resolution time.

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const maxStr = flags.max
    let max: number | null = null
    if (typeof maxStr === 'string' && maxStr.length > 0) {
      const parsed = Number.parseInt(maxStr, 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError(`--max must be a positive integer (got "${maxStr}")`)
      }
      max = parsed
    }

    const worker = this.app.resolve(Worker)
    const controller = new AbortController()
    const sigint = () => controller.abort()
    const sigterm = () => controller.abort()
    process.once('SIGINT', sigint)
    process.once('SIGTERM', sigterm)

    this.info(`Worker started — queue=${flags.queue}${max !== null ? `, max=${max}` : ''}.`)
    try {
      if (max === null) {
        await worker.run(controller.signal)
      } else {
        // Bounded loop — `processOne()` returns null when nothing's claimable;
        // sleep briefly so we don't spin-poll an empty queue.
        let processed = 0
        while (processed < max && !controller.signal.aborted) {
          const result = await worker.processOne()
          if (result === null) {
            await sleep(1000, controller.signal)
            continue
          }
          processed++
        }
        this.info(`Stopped after ${processed} job(s).`)
      }
      return ExitCode.Success
    } finally {
      process.off('SIGINT', sigint)
      process.off('SIGTERM', sigterm)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
