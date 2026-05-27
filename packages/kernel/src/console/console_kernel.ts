/**
 * `ConsoleKernel` — the transport layer for command-line entry points.
 *
 * Lifecycle of `handle(argv)`:
 *   1. Parse argv → `{ command, args, flags }`.
 *   2. If no command, or `list` / `--help` / `-h` → print the command list,
 *      return 0.
 *   3. Resolve the matching `CommandClass` from the registry. If none →
 *      print error to stderr, return 1.
 *   4. Construct the command via the container (`app.make(Class)`) so its
 *      `@inject()` deps are wired.
 *   5. Call `await cmd.handle(ctx)`. Numeric return → that exit code;
 *      void → 0. A thrown error is normalised via `asStravError`, surfaced
 *      to stderr, and produces exit code 1.
 *
 * `ConsoleKernel.run({ argv, providers?, commands?, app?, signalHandlers? })`
 * is the convenience static for `bin/strav.ts`: builds (or accepts) an
 * Application, registers providers + commands, boots, dispatches, shuts down.
 *
 * @see docs/kernel/api.md
 * @see docs/kernel/guides/console.md
 * @see spec/lifecycles.md
 */

import { Application } from '../core/application.ts'
import type { ServiceProvider } from '../core/service_provider.ts'
import { asStravError } from '../exceptions/as_strav_error.ts'
import { ConfigError } from '../exceptions/config_error.ts'
import { parseArgv } from './argv.ts'
import type { Command, CommandClass } from './command.ts'
import { ConsoleOutput, type ConsoleOutputOptions } from './console_output.ts'

export interface ConsoleRunOptions {
  /** Argv slice — typically `process.argv.slice(2)`. */
  argv: readonly string[]
  /**
   * Pre-built Application. When omitted, the kernel constructs one. Useful
   * for tests that want to inspect/seed the container after construction.
   */
  app?: Application
  /** Providers to register before boot. Ignored when `app` is already booted. */
  providers?: readonly ServiceProvider[]
  /** Commands to register. */
  commands?: readonly CommandClass[]
  /**
   * Install SIGINT/SIGTERM handlers. Default `false` for console — most
   * console invocations are short-lived and a Ctrl-C should exit promptly.
   */
  signalHandlers?: boolean
  /** Output options (useful for tests). */
  output?: ConsoleOutputOptions
}

export class ConsoleKernel {
  private readonly byName = new Map<string, CommandClass>()

  constructor(
    public readonly app: Application,
    private readonly output: ConsoleOutput = new ConsoleOutput(),
  ) {}

  /** Register one or more commands. Throws `ConfigError` on duplicate signature. */
  register(...Classes: CommandClass[]): this {
    for (const Class of Classes) {
      const signature = (Class as { signature?: unknown }).signature
      if (typeof signature !== 'string' || signature.length === 0) {
        throw new ConfigError(
          `Command ${Class.name}: missing static \`signature\` field (got ${String(signature)})`,
        )
      }
      if (this.byName.has(signature)) {
        const existing = this.byName.get(signature) as CommandClass
        throw new ConfigError(
          `Command "${signature}" is registered twice (${existing.name} and ${Class.name})`,
        )
      }
      this.byName.set(signature, Class)
    }
    return this
  }

  /** Iteration helper for tests / introspection. */
  commands(): readonly CommandClass[] {
    return [...this.byName.values()]
  }

  /**
   * Dispatch a single argv vector. Returns the exit code. Assumes the
   * application is booted.
   */
  async handle(argv: readonly string[]): Promise<number> {
    const { command, args, flags } = parseArgv(argv)

    if (command === undefined || command === 'list' || command === '--help' || command === '-h') {
      this.printList()
      return 0
    }

    const Class = this.byName.get(command)
    if (Class === undefined) {
      this.output.error(`Unknown command "${command}". Run "list" to see available commands.`)
      return 1
    }

    try {
      const cmd = this.app.make(Class) as Command
      const result = await cmd.handle({
        args,
        flags,
        out: this.output,
        app: this.app,
      })
      return typeof result === 'number' ? result : 0
    } catch (caught) {
      const error = asStravError(caught)
      this.output.error(`${error.name}: ${error.message}`)
      if (!this.app.isProduction() && caught instanceof Error && caught.stack) {
        this.output.writeError(`${caught.stack}\n`)
      }
      return 1
    }
  }

  /**
   * Entry point. Builds (or accepts) an Application, boots it, dispatches
   * one argv, shuts down. The caller decides whether to `process.exit`.
   */
  static async run(options: ConsoleRunOptions): Promise<number> {
    const app = options.app ?? new Application()
    if (options.providers && options.providers.length > 0) {
      app.useProviders([...options.providers])
    }

    const output = new ConsoleOutput(options.output ?? {})
    const kernel = new ConsoleKernel(app, output)
    if (options.commands && options.commands.length > 0) {
      kernel.register(...options.commands)
    }

    const startedHere = !app.isBooted
    try {
      if (startedHere) await app.start({ signalHandlers: options.signalHandlers ?? false })
      return await kernel.handle(options.argv)
    } catch (caught) {
      const error = asStravError(caught)
      output.error(`${error.name}: ${error.message}`)
      if (!app.isProduction() && caught instanceof Error && caught.stack) {
        output.writeError(`${caught.stack}\n`)
      }
      return 1
    } finally {
      if (startedHere && app.isBooted) await app.shutdown()
    }
  }

  private printList(): void {
    this.output.line('Available commands:')
    if (this.byName.size === 0) {
      this.output.line('  (none registered)')
      return
    }
    const entries = [...this.byName].sort(([a], [b]) => a.localeCompare(b))
    const max = Math.max(...entries.map(([name]) => name.length))
    for (const [name, Class] of entries) {
      this.output.line(`  ${name.padEnd(max)}  ${Class.description}`)
    }
  }
}
