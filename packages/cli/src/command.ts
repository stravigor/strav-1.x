/**
 * `Command` — base class for CLI commands.
 *
 * Wraps `@strav/kernel`'s minimal `Command` (which exposes `handle(ctx)` with
 * positional `args: readonly string[]`) and adds:
 *   - The signature DSL (`'cmd {arg} {arg?} {--flag=default}'`), parsed once
 *     at registration time. `execute({ args, flags })` receives the bound
 *     values keyed by name.
 *   - Output helpers as instance methods (`this.info` / `this.warn` / …) so
 *     command bodies stay declarative without threading the writer around.
 *   - Interactive prompts (`this.confirm`, `this.ask`, `this.choice`,
 *     `this.table`) backed by Bun's stdin reader.
 *   - `static providers?: string[]` — names of providers to boot. Resolved
 *     by the `CliConsoleKernel` against the default list (transitive deps
 *     auto-included). Omit for "boot everything"; `[]` for "boot nothing".
 *
 * Subclasses implement `execute(args)` and return a number (exit code) or
 * void (treated as 0). Errors thrown from `execute()` bubble up to the
 * kernel, which surfaces them via stderr + returns exit 1.
 */

import { type CommandContext, type CommandResult, Command as KernelCommand } from '@strav/kernel'
import { type BoundArgv, bindArgv, UsageError } from './binder.ts'
import { ExitCode } from './exit_codes.ts'
import { parseSignature, type Signature } from './signature.ts'

export interface ExecuteArgs {
  /** Positional args, keyed by name (from `{name}` in the signature). */
  args: Record<string, string | undefined>
  /**
   * Parsed flags, keyed by name. Boolean flags resolve to `false` by default;
   * string flags to their declared default. Undeclared flags pass through.
   */
  flags: Record<string, string | boolean>
}

/**
 * Static metadata every CLI command must declare. The richer `signature` is
 * the source of truth for argv binding — the bare command name is derived
 * from its first token. `description` is the one-liner shown by `list`.
 */
export interface CliCommandMeta {
  readonly signature: string
  readonly description: string
  /**
   * Subset of provider names to boot for this command. Omitted = full default
   * list. `[]` = none. See `docs/cli/guides/subset-boot.md`.
   */
  readonly providers?: readonly string[]
}

export abstract class Command extends KernelCommand {
  /** Lazily-built `Signature` from `static signature`. Re-used across handle() calls. */
  private static signatureCache: WeakMap<typeof Command, Signature> = new WeakMap()

  static parsedSignature(): Signature {
    // `this` here refers to the SUBCLASS that called .parsedSignature(), which
    // is what we want — the cache keys per-subclass so each command parses its
    // signature once. Using the literal `Command` name would collapse all
    // subclasses to the same key.
    // biome-ignore lint/complexity/noThisInStatic: intentional subclass-aware cache
    const Class = this as typeof Command
    const cached = Command.signatureCache.get(Class)
    if (cached) return cached
    const raw = (Class as { signature?: unknown }).signature
    if (typeof raw !== 'string') {
      throw new Error(
        `${Class.name}: missing static \`signature\` string — every Command needs one`,
      )
    }
    const parsed = parseSignature(raw)
    Command.signatureCache.set(Class, parsed)
    return parsed
  }

  /** Kernel calls this with positional argv; we re-bind via the signature and call `execute()`. */
  // biome-ignore lint/suspicious/noConfusingVoidType: matches kernel's CommandResult — void means "treat as 0"
  override async handle(ctx: CommandContext): Promise<number | void> {
    const Class = this.constructor as typeof Command
    const signature = Class.parsedSignature()
    this.output = ctx.out

    // `<cmd> --help` short-circuits to per-command help.
    if (ctx.flags.help === true || ctx.flags.h === true) {
      this.printHelp()
      return 0
    }

    // The kernel's argv parser already split positional vs flag tokens; we just
    // need to fold them back into the BoundArgv shape `execute()` expects.
    let bound: BoundArgv
    try {
      bound = bindArgv(signature, {
        command: signature.name,
        args: [...ctx.args],
        flags: { ...ctx.flags },
      })
    } catch (err) {
      // UsageError → POSIX exit code 2 + per-command usage line on stderr.
      // We catch it here (not in the kernel) so other exceptions still get
      // the kernel's generic exit-1 + stack-trace treatment.
      if (err instanceof UsageError) {
        this.error(err.message)
        this.error(`Usage: ${formatUsage(signature)}`)
        return ExitCode.UsageError
      }
      throw err
    }
    return this.execute(bound)
  }

  /**
   * Print the help message for this command. Composed from `static description`
   * + the parsed signature + the optional `help()` override.
   */
  protected printHelp(): void {
    const Class = this.constructor as typeof Command
    const signature = Class.parsedSignature()
    const description = (Class as { description?: unknown }).description
    if (typeof description === 'string' && description.length > 0) {
      this.line(description)
      this.line()
    }
    this.line(`Usage: ${formatUsage(signature)}`)
    if (signature.args.length > 0) {
      this.line()
      this.line('Arguments:')
      for (const arg of signature.args) {
        this.line(`  ${arg.name}${arg.optional ? '?' : ''}`)
      }
    }
    if (signature.flags.length > 0) {
      this.line()
      this.line('Flags:')
      for (const flag of signature.flags) {
        const suffix = flag.kind === 'string' ? `=<value> (default: ${flag.default})` : ' (boolean)'
        this.line(`  --${flag.name}${suffix}`)
      }
    }
    const extra = this.help()
    if (extra) {
      this.line()
      this.line(extra)
    }
  }

  /** Set by `handle()` before calling `execute()`. */
  protected output!: CommandContext['out']

  /** Implement the command. Return a number for an explicit exit code, void for 0. */
  abstract execute(argv: ExecuteArgs): CommandResult

  // ─── output helpers — thin wrappers around ConsoleOutput ─────────────────────

  protected info(msg: string): void {
    this.output.info(msg)
  }
  protected success(msg: string): void {
    this.output.success(msg)
  }
  protected warn(msg: string): void {
    this.output.warn(msg)
  }
  protected error(msg: string): void {
    this.output.error(msg)
  }
  protected line(msg = ''): void {
    this.output.line(msg)
  }

  /**
   * Print a table with aligned columns. Headers + every row are stringified;
   * column widths derived from the widest cell. Apps that need fancier
   * tables write to `this.output` directly.
   */
  protected table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
    )
    const fmt = (cells: readonly string[]) =>
      cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ')
    this.line(fmt(headers))
    this.line(widths.map((w) => '-'.repeat(w)).join('  '))
    for (const row of rows) this.line(fmt(row))
  }

  /**
   * Yes/no prompt. Accepts `y`/`yes` (case-insensitive) as `true`; anything
   * else (including empty input) as `false`. Use `defaultYes: true` to flip
   * empty input to `true`.
   */
  protected async confirm(question: string, opts: { defaultYes?: boolean } = {}): Promise<boolean> {
    const suffix = opts.defaultYes ? ' [Y/n] ' : ' [y/N] '
    this.output.write(`${question}${suffix}`)
    const answer = (await readStdinLine()).trim().toLowerCase()
    if (answer === '') return opts.defaultYes ?? false
    return answer === 'y' || answer === 'yes'
  }

  /** Free-text prompt. Returns the default when the user just hits enter. */
  protected async ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' '
    this.output.write(`${question}${suffix}`)
    const answer = (await readStdinLine()).trim()
    if (answer === '') return defaultValue ?? ''
    return answer
  }

  /**
   * Multiple-choice prompt — prints options as a numbered list, accepts
   * either the number or the option text. Re-prompts on bad input.
   */
  protected async choice<T extends string>(
    question: string,
    options: readonly T[],
    defaultValue?: T,
  ): Promise<T> {
    if (options.length === 0) {
      throw new Error('choice(): options must be non-empty')
    }
    while (true) {
      this.line(question)
      for (let i = 0; i < options.length; i++) {
        const marker = options[i] === defaultValue ? ' (default)' : ''
        this.line(`  ${i + 1}. ${options[i]}${marker}`)
      }
      this.output.write('> ')
      const raw = (await readStdinLine()).trim()
      if (raw === '' && defaultValue !== undefined) return defaultValue
      const asNum = Number.parseInt(raw, 10)
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
        return options[asNum - 1] as T
      }
      const match = options.find((o) => o === raw)
      if (match !== undefined) return match
      this.warn(`Invalid choice: "${raw}"`)
    }
  }

  /** Optional per-command help text. Override to provide examples / extra detail. */
  help(): string | undefined {
    return undefined
  }
}

/** Render `cmd {arg} {arg?} [--flag=…]` from a parsed signature for help output. */
function formatUsage(signature: Signature): string {
  const parts: string[] = [signature.name]
  for (const arg of signature.args) parts.push(arg.optional ? `[${arg.name}]` : `<${arg.name}>`)
  for (const flag of signature.flags) {
    parts.push(flag.kind === 'string' ? `[--${flag.name}=…]` : `[--${flag.name}]`)
  }
  return parts.join(' ')
}

/**
 * Read one line from stdin. Returns the empty string at EOF. Decoded as UTF-8.
 *
 * Bun's `console.readLine()` blocks the event loop; this uses the `for await`
 * stream interface so other async work (e.g., a spinner) can run alongside.
 */
async function readStdinLine(): Promise<string> {
  let buf = ''
  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true })
    const newline = buf.indexOf('\n')
    if (newline !== -1) {
      return buf.slice(0, newline).replace(/\r$/, '')
    }
  }
  buf += decoder.decode()
  return buf.replace(/\r$/, '')
}

/**
 * Constructor type the `CliConsoleKernel` accepts. Combines the runtime
 * constructor (so the container can `make()` it) with the static metadata
 * the kernel reads at registration / dispatch time.
 */
export type CliCommandClass<T extends Command = Command> = (new (
  // biome-ignore lint/suspicious/noExplicitAny: structural ctor — Command subclasses vary in injected deps
  ...args: any[]
) => T) &
  CliCommandMeta
