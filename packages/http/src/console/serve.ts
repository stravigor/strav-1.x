/**
 * `bun strav serve [--port=3000] [--hostname=0.0.0.0]` — start the HTTP server.
 *
 * Resolves `HttpKernel`, calls `kernel.serve(opts)`, then waits for
 * SIGINT / SIGTERM before calling `server.stop()` cleanly.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { HttpKernel } from '../http_kernel.ts'

export class Serve extends Command {
  static signature = 'serve {--port=3000} {--hostname=0.0.0.0}'
  static description = 'Start the HTTP server.'

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

    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })

    this.info('Shutting down…')
    await server.stop(false)
    return ExitCode.Success
  }
}
