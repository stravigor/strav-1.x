/**
 * Argv binder — given a parsed `Signature` and the kernel's `ParsedArgv`,
 * produce the `{ args, flags }` shape `Command.execute()` receives.
 *
 * Validation is loud-fail (`UsageError`) so wrong invocations land an exit
 * code 2 with a clear message rather than a `TypeError` from `args.foo`:
 *   - Required positional missing → "missing argument: <name>".
 *   - Extra positional after all declared → "unexpected argument: <value>".
 *   - String flag with no value (bare `--output`) → "flag --output requires a value".
 *
 * Unknown flags (passed but not declared) are *retained* in the output —
 * commands may inspect them via `flags[<unknown>]`, which is the escape
 * hatch for ad-hoc flags without growing the signature. They never error.
 */

import { type ParsedArgv, StravError, type StravErrorOptions } from '@strav/kernel'
import type { Signature } from './signature.ts'

/**
 * Thrown when argv doesn't match a `Signature` — missing required positional,
 * unexpected extra positional, or a value-flag with no value. Status 2 mirrors
 * the POSIX "usage error" exit-code convention; the CliConsoleKernel surfaces
 * it as exit code 2.
 */
export class UsageError extends StravError {
  constructor(message: string, options: StravErrorOptions = {}) {
    super(message, { code: 'cli.usage', status: 2 }, options)
  }
}

export interface BoundArgv {
  args: Record<string, string | undefined>
  flags: Record<string, string | boolean>
}

export function bindArgv(signature: Signature, parsed: ParsedArgv): BoundArgv {
  const args: Record<string, string | undefined> = {}
  const flags: Record<string, string | boolean> = {}

  // ─── positionals ────────────────────────────────────────────────────────────
  for (let i = 0; i < signature.args.length; i++) {
    const spec = signature.args[i]
    if (!spec) continue
    const value = parsed.args[i]
    if (value === undefined) {
      if (!spec.optional) {
        throw new UsageError(`missing argument: <${spec.name}>`)
      }
      args[spec.name] = undefined
    } else {
      args[spec.name] = value
    }
  }

  if (parsed.args.length > signature.args.length) {
    const extra = parsed.args[signature.args.length]
    throw new UsageError(`unexpected argument: "${extra}"`)
  }

  // ─── declared flags ─────────────────────────────────────────────────────────
  const declaredFlagNames = new Set<string>()
  for (const spec of signature.flags) {
    declaredFlagNames.add(spec.name)
    const raw = parsed.flags[spec.name]
    if (raw === undefined) {
      flags[spec.name] = spec.default
      continue
    }
    if (spec.kind === 'boolean') {
      // Bare `--flag` parses as `true`; an explicit `--flag=foo` also flips
      // it to true (the value is meaningless for a boolean — we ignore it
      // rather than error so `--verbose=1` from CI scripts doesn't surprise).
      flags[spec.name] = raw !== false
    } else {
      if (raw === true) {
        throw new UsageError(`flag --${spec.name} requires a value`)
      }
      flags[spec.name] = raw
    }
  }

  // ─── undeclared flags (pass through) ────────────────────────────────────────
  for (const [name, value] of Object.entries(parsed.flags)) {
    if (!declaredFlagNames.has(name)) flags[name] = value
  }

  return { args, flags }
}
