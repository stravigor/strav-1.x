/**
 * Argv parser for the console kernel.
 *
 * Recognized forms:
 *   --flag             → { flag: true }
 *   --flag=value       → { flag: 'value' }
 *   --flag value       → { flag: 'value' }  (when value doesn't start with `-`)
 *   -f                 → { f: true }
 *   <positional>       → first non-flag → command; rest → args
 *
 * Notes:
 *   - The first non-flag token is the command name; everything after is `args`.
 *   - `--` ends flag parsing; remaining tokens are positional even if they
 *     start with `-` (POSIX-style).
 *   - Repeating a flag overwrites the previous value (last-wins).
 *   - `--flag <token>` consumes the next token as the flag's value when that
 *     token doesn't start with `-`. This means flags before the command can
 *     accidentally swallow it: `--verbose run` reads as `--verbose=run`. Put
 *     flags AFTER the command, or use the unambiguous `--flag=value` form.
 *
 * @see docs/kernel/api.md
 */

export interface ParsedArgv {
  /** The command name (first positional token), or `undefined` if argv had none. */
  command: string | undefined
  /** Positional arguments after the command name. */
  args: string[]
  /** Parsed flags. */
  flags: Record<string, string | boolean>
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  let command: string | undefined
  let endOfFlags = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (!endOfFlags && token === '--') {
      endOfFlags = true
      continue
    }

    if (!endOfFlags && token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1)
      } else {
        const name = token.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next
          i++
        } else {
          flags[name] = true
        }
      }
      continue
    }

    if (!endOfFlags && token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = true
      continue
    }

    if (command === undefined) {
      command = token
    } else {
      args.push(token)
    }
  }

  return { command, args, flags }
}
