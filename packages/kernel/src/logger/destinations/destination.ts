/**
 * Minimal destination interface used by every Strav log channel.
 *
 * Pino calls `.write(jsonLine)` with one terminated JSON line per log event.
 * Implementations may transform (pretty-print), fan out (stack), or persist
 * (file). All destinations may expose an async `.close()` so the LogManager
 * can flush + release them at shutdown.
 */

export interface LogDestination {
  /** Write one already-serialized JSON line (terminated by `\n`). */
  write(line: string): void
  /** Flush any buffered data and release resources. */
  close?(): void | Promise<void>
}
