/**
 * The context passed to every `Command.handle()` call. Carries parsed argv
 * data, the output writer, and the booted Application (so commands can
 * resolve services dynamically).
 *
 * @see docs/kernel/api.md
 */

import type { Application } from '../core/application.ts'
import type { ConsoleOutput } from './console_output.ts'

export interface CommandContext {
  /** Positional arguments — everything after the command name that isn't a flag. */
  readonly args: readonly string[]
  /**
   * Parsed flags. `--flag=value` and `--flag value` both produce `{ flag: 'value' }`;
   * a bare `--flag` produces `{ flag: true }`.
   */
  readonly flags: Readonly<Record<string, string | boolean>>
  /** Writer for stdout / stderr with ANSI color support. */
  readonly out: ConsoleOutput
  /** The booted Application — use for ad-hoc container resolution. */
  readonly app: Application
}
