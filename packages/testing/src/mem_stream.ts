/**
 * In-memory `WritableStream` for tests that assert on stdout/stderr.
 *
 * Pairs with `@strav/kernel`'s `ConsoleOutput` and `@strav/cli`'s
 * command/`runCli` flows — both accept a `NodeJS.WritableStream`
 * pair, and `MemStream` is the smallest possible double that lets
 * tests inspect what was written.
 *
 * ```ts
 * import { MemStream } from '@strav/testing'
 * import { ConsoleOutput } from '@strav/kernel'
 *
 * const stdout = new MemStream()
 * const out = new ConsoleOutput({ stdout: stdout.asWritable(), useColor: false })
 * out.line('hello')
 * expect(stdout.text()).toBe('hello\n')
 * ```
 *
 * `asWritable()` exists so callers don't need the `as unknown as
 * NodeJS.WritableStream` cast at every test site — the cast is
 * confined to this module's boundary.
 */

export class MemStream {
  readonly chunks: string[] = []

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  /** Concatenated written content. */
  text(): string {
    return this.chunks.join('')
  }

  /** Drop everything written so far. Useful between assertions in a single test. */
  clear(): void {
    this.chunks.length = 0
  }

  /**
   * Cast to `NodeJS.WritableStream` for APIs that demand the full
   * Node interface (`ConsoleOutput`, child-process stdio, etc.).
   * Confines the boundary cast to this method.
   */
  asWritable(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream
  }
}
