/**
 * `ConsoleOutput` — minimal, dependency-free terminal output with ANSI colors.
 *
 * Color is applied only when stdout is a TTY (auto-detected) — pipe to a file
 * and you get plain text. Tests inject custom writers and pass `useColor: true`
 * to force colored output for assertions, or `false` to assert plain text.
 *
 * @see docs/kernel/api.md
 */

const ESC = `\u001b[`
const RESET = `${ESC}0m`

export interface ConsoleOutputOptions {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  /** Force-enable / -disable color. Default: auto-detect via stdout.isTTY. */
  useColor?: boolean
}

export class ConsoleOutput {
  private readonly stdout: NodeJS.WritableStream
  private readonly stderr: NodeJS.WritableStream
  private readonly useColor: boolean

  constructor(options: ConsoleOutputOptions = {}) {
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    this.useColor = options.useColor ?? Boolean((this.stdout as NodeJS.WriteStream).isTTY)
  }

  /** Write a line to stdout. */
  line(msg = ''): void {
    this.stdout.write(`${msg}\n`)
  }

  /** Blue. */
  info(msg: string): void {
    this.line(this.color('34', msg))
  }

  /** Green. */
  success(msg: string): void {
    this.line(this.color('32', msg))
  }

  /** Yellow. */
  warn(msg: string): void {
    this.line(this.color('33', msg))
  }

  /** Red. Routed to stderr. */
  error(msg: string): void {
    this.stderr.write(`${this.color('31', msg)}\n`)
  }

  /** Raw write to stdout (no trailing newline). */
  write(msg: string): void {
    this.stdout.write(msg)
  }

  /** Raw write to stderr (no trailing newline). */
  writeError(msg: string): void {
    this.stderr.write(msg)
  }

  private color(code: string, msg: string): string {
    return this.useColor ? `${ESC}${code}m${msg}${RESET}` : msg
  }
}
