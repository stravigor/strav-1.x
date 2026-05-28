/**
 * POSIX-aligned exit-code constants. Commands return one of these (or any
 * number ≥ 100 for command-specific failures); the framework defaults to
 * 0 when `execute()` returns `void` and 1 when an error escapes.
 *
 * Apps reach for these via `import { ExitCode } from '@strav/cli'` so the
 * call site reads `return ExitCode.UsageError` instead of a magic `2`.
 */

export const ExitCode = {
  /** Success. */
  Success: 0,
  /** Unspecified failure. The kernel uses this when an exception escapes. */
  GenericFailure: 1,
  /**
   * Argv didn't match the command's signature — missing positional, extra
   * positional, value-flag with no value. Thrown by the binder as `UsageError`.
   */
  UsageError: 2,
  /** Configuration is invalid or missing (e.g., `APP_KEY` unset). */
  ConfigError: 64,
  /** Data dependency unavailable (DB unreachable, file missing). */
  DataError: 65,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]
