/**
 * `runCli` — entry point for `bin/strav.ts`.
 *
 * Flow:
 *   1. Parse argv to find the command name (no app yet).
 *   2. Look up the matching `CliCommandClass` by signature first-token.
 *   3. Read its `static providers` (if any) → filter `defaultProviders`
 *      with transitive deps auto-included.
 *   4. Build (or accept) the Application. Register the filtered providers.
 *   5. Hand off to `@strav/kernel`'s `ConsoleKernel.run(...)`, which boots,
 *      dispatches, and shuts down. Per-command argv binding happens inside
 *      `Command.handle()` (the kernel calls `handle`, our base re-binds).
 *
 * Return: the dispatch's exit code. Callers in `bin/strav.ts` are expected
 * to forward it via `process.exit(code)`.
 *
 * Args:
 *   - `argv` — typically `process.argv.slice(2)`.
 *   - `defaultProviders` — the full provider list from `bootstrap/providers.ts`.
 *   - `commands` — optional explicit command list. When omitted, every
 *     `ConsoleProvider` subclass found in `defaultProviders` contributes its
 *     `commands` array.
 *   - `app` — pre-built Application (tests). When omitted, one is constructed.
 */

import {
  type Application,
  ConfigError,
  ConsoleKernel,
  type ConsoleOutputOptions,
  parseArgv,
  type ServiceProvider,
} from '@strav/kernel'
import type { CliCommandClass } from './command.ts'
import { collectCommands } from './console_provider.ts'
import { selectProviders } from './subset_boot.ts'

export interface RunCliOptions {
  argv: readonly string[]
  /** Full default provider list — typically from `bootstrap/providers.ts`. */
  defaultProviders: readonly ServiceProvider[]
  /**
   * Explicit command list. Optional — when omitted, commands are collected
   * from every `ConsoleProvider` subclass in `defaultProviders`.
   */
  commands?: readonly CliCommandClass[]
  /** Pre-built application (tests). */
  app?: Application
  output?: ConsoleOutputOptions
  /** Install SIGINT/SIGTERM handlers. Default `false` for console. */
  signalHandlers?: boolean
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const commands = options.commands ?? collectCommands(options.defaultProviders)
  assertUniqueCommands(commands)
  const byName = indexByName(commands)
  const { command: commandName } = parseArgv(options.argv)

  // ─── pick the subset of providers to boot ──────────────────────────────────
  // No command (or `list` / `--help`) → boot nothing; the kernel just prints
  // the registered list. Apps that wire a custom listing command can override.
  let providers: ServiceProvider[]
  if (
    commandName === undefined ||
    commandName === 'list' ||
    commandName === '--help' ||
    commandName === '-h'
  ) {
    providers = []
  } else {
    const Class = byName.get(commandName)
    const requested = (Class as { providers?: readonly string[] } | undefined)?.providers
    providers = selectProviders(options.defaultProviders, requested, commandName)
  }

  // ─── delegate to kernel's ConsoleKernel.run ────────────────────────────────
  const runArgs: {
    argv: readonly string[]
    providers: ServiceProvider[]
    commands: readonly CliCommandClass[]
    signalHandlers: boolean
    app?: Application
    output?: ConsoleOutputOptions
  } = {
    argv: options.argv,
    providers,
    commands,
    signalHandlers: options.signalHandlers ?? false,
  }
  if (options.app !== undefined) runArgs.app = options.app
  if (options.output !== undefined) runArgs.output = options.output
  return ConsoleKernel.run(runArgs)
}

function assertUniqueCommands(commands: readonly CliCommandClass[]): void {
  const seen = new Map<string, CliCommandClass>()
  for (const Class of commands) {
    const name = firstToken(Class.signature)
    const existing = seen.get(name)
    if (existing) {
      throw new ConfigError(
        `runCli: command "${name}" declared twice (${existing.name} and ${Class.name})`,
      )
    }
    seen.set(name, Class)
  }
}

function indexByName(commands: readonly CliCommandClass[]): Map<string, CliCommandClass> {
  const out = new Map<string, CliCommandClass>()
  for (const Class of commands) out.set(firstToken(Class.signature), Class)
  return out
}

/** Pull the command name (first whitespace-delimited token) out of a signature. */
function firstToken(signature: string): string {
  const trimmed = signature.trimStart()
  const space = trimmed.search(/\s/)
  return space === -1 ? trimmed : trimmed.slice(0, space)
}
