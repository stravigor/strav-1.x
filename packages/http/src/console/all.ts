/**
 * `bun strav all [--port=3000] [--hostname=0.0.0.0]` — single-process mode.
 *
 * Starts HTTP + optionally queue worker + optionally scheduler in ONE
 * Bun process. Intended for small deployments (Railway hobby, Fly hobby,
 * MVPs) that want one container.
 *
 * Worker + Scheduler are optional: the command checks `app.has(Worker)` /
 * `app.has(Scheduler)` before resolving. Apps that don't bind them get a
 * pure HTTP server — effectively the same as `serve`.
 *
 * SIGINT / SIGTERM aborts everything. The HTTP server stops; the Worker
 * and Scheduler loops exit within one tick.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { HttpKernel } from '../http_kernel.ts'

export class All extends Command {
  static signature = 'all {--port=3000} {--hostname=0.0.0.0}'
  static description =
    'Start HTTP + queue worker + scheduler in one process (small-deployment mode).'

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const port = Number(flags.port as string)
    const hostname = flags.hostname as string
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.error(`--port must be a valid port number (got "${flags.port}")`)
      return ExitCode.UsageError
    }

    const kernel = this.app.resolve(HttpKernel)
    const server = kernel.serve({ port, hostname })
    this.success(`HTTP server listening on http://${server.hostname}:${server.port}/`)

    const controller = new AbortController()
    process.once('SIGINT', () => controller.abort())
    process.once('SIGTERM', () => controller.abort())

    const tasks: Promise<unknown>[] = []

    // Worker — optional
    if (this.app.has(workerClass())) {
      const Worker = workerClass()
      const worker = this.app.resolve(Worker)
      this.info('Queue worker started.')
      tasks.push((worker as { run: (s: AbortSignal) => Promise<void> }).run(controller.signal))
    }

    // Scheduler — optional
    if (this.app.has(schedulerClass())) {
      const Scheduler = schedulerClass()
      const scheduler = this.app.resolve(Scheduler)
      this.info('Scheduler started.')
      tasks.push((scheduler as { run: (s: AbortSignal) => Promise<void> }).run(controller.signal))
    }

    // Wait until abort.
    await Promise.all([
      new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
      }),
      ...tasks,
    ])

    this.info('Shutting down…')
    await server.stop(false)
    return ExitCode.Success
  }
}

/**
 * Lazy imports for Worker + Scheduler from @strav/queue. Using `import type`
 * and dynamic class lookup so @strav/http doesn't take a hard compile-time
 * dep on @strav/queue (which may not be installed). We check app.has() by
 * looking for the class symbol in the container; if it isn't there we skip.
 *
 * The pattern: return a well-known class sentinel whose module we import
 * dynamically. If import fails (package not installed), return null and skip.
 */
function workerClass(): new (...args: unknown[]) => unknown {
  // If @strav/queue is installed the dynamic import succeeds. The class
  // key doesn't need to be the real Worker — the has() check only needs
  // to agree with what the app registered. So we just attempt the import;
  // if it throws we return a fresh anonymous class that can never match.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional dep
    const mod = require('@strav/queue') as any
    return mod.Worker as new (
      ...args: unknown[]
    ) => unknown
  } catch {
    return class __MissingWorker__ {} as new (
      ...args: unknown[]
    ) => unknown
  }
}

function schedulerClass(): new (...args: unknown[]) => unknown {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional dep
    const mod = require('@strav/queue') as any
    return mod.Scheduler as new (
      ...args: unknown[]
    ) => unknown
  } catch {
    return class __MissingScheduler__ {} as new (
      ...args: unknown[]
    ) => unknown
  }
}
