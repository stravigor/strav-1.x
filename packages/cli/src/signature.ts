/**
 * Signature DSL — parses `'cmd {arg} {arg?} {--flag=default} {--bool}'` into
 * a structured `Signature` the `Command` base + `CliConsoleKernel` use to
 * dispatch argv onto `execute({ args, flags })`.
 *
 * Grammar (each piece separated by whitespace):
 *   - `name`               → command name (first token, no curlies).
 *   - `{slug}`             → required positional named `slug`.
 *   - `{target?}`          → optional positional named `target` (undefined when missing).
 *   - `{--output}`         → boolean flag named `output` (default `false`).
 *   - `{--output=val}`     → string flag named `output` (default `'val'`).
 *
 * Constraints (enforced by `parseSignature`):
 *   - First token IS the command name and never carries `{}`.
 *   - All required positionals come before optionals.
 *   - Positional + flag names are unique within a signature.
 *
 * Unknown shapes throw `ConfigError` at parse time — typos surface at command
 * registration, not at the user's first attempt to run.
 */

import { ConfigError } from '@strav/kernel'

export interface PositionalArg {
  /** Identifier accessible as `args.<name>` in execute(). */
  name: string
  optional: boolean
}

export type FlagSpec =
  | {
      kind: 'boolean'
      name: string
      /** Always `false` — bare `--flag` flips it to `true`. */
      default: false
    }
  | {
      kind: 'string'
      name: string
      /** Default returned when the flag is absent. */
      default: string
    }

export interface Signature {
  /** Command name — what users type as the first argv token. */
  name: string
  args: PositionalArg[]
  flags: FlagSpec[]
}

/**
 * Parse a signature string into a structured `Signature`. Throws `ConfigError`
 * with a clear message on any malformed token.
 */
export function parseSignature(signature: string): Signature {
  const tokens = tokenize(signature)
  if (tokens.length === 0) {
    throw new ConfigError(`parseSignature: empty signature`)
  }
  const first = tokens[0] ?? ''
  if (first.startsWith('{')) {
    throw new ConfigError(
      `parseSignature("${signature}"): first token must be the command name, not "${first}"`,
    )
  }
  const name = first

  const args: PositionalArg[] = []
  const flags: FlagSpec[] = []
  const seenArgNames = new Set<string>()
  const seenFlagNames = new Set<string>()
  let sawOptional = false

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? ''
    if (!tok.startsWith('{') || !tok.endsWith('}')) {
      throw new ConfigError(`parseSignature("${signature}"): token "${tok}" must be wrapped in {…}`)
    }
    const inner = tok.slice(1, -1)
    if (inner.startsWith('--')) {
      const flag = parseFlag(inner.slice(2), signature)
      if (seenFlagNames.has(flag.name)) {
        throw new ConfigError(
          `parseSignature("${signature}"): flag "--${flag.name}" declared twice`,
        )
      }
      seenFlagNames.add(flag.name)
      flags.push(flag)
    } else {
      const arg = parsePositional(inner, signature)
      if (seenArgNames.has(arg.name)) {
        throw new ConfigError(
          `parseSignature("${signature}"): positional "${arg.name}" declared twice`,
        )
      }
      if (sawOptional && !arg.optional) {
        throw new ConfigError(
          `parseSignature("${signature}"): required positional "${arg.name}" cannot follow an optional one — argv parsing would be ambiguous`,
        )
      }
      if (arg.optional) sawOptional = true
      seenArgNames.add(arg.name)
      args.push(arg)
    }
  }

  return { name, args, flags }
}

function parsePositional(inner: string, signature: string): PositionalArg {
  if (inner.endsWith('?')) {
    const name = inner.slice(0, -1)
    validateIdentifier(name, signature)
    return { name, optional: true }
  }
  validateIdentifier(inner, signature)
  return { name: inner, optional: false }
}

function parseFlag(inner: string, signature: string): FlagSpec {
  const eq = inner.indexOf('=')
  if (eq === -1) {
    validateIdentifier(inner, signature)
    return { kind: 'boolean', name: inner, default: false }
  }
  const name = inner.slice(0, eq)
  const value = inner.slice(eq + 1)
  validateIdentifier(name, signature)
  return { kind: 'string', name, default: value }
}

function validateIdentifier(name: string, signature: string): void {
  if (name.length === 0) {
    throw new ConfigError(`parseSignature("${signature}"): empty identifier`)
  }
  // Allow letters, digits, dash, underscore. CLI flag/arg names mirror what
  // users would type — kebab-case is fine.
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new ConfigError(
      `parseSignature("${signature}"): "${name}" is not a valid identifier (letters, digits, dash, underscore; must start with a letter)`,
    )
  }
}

/**
 * Tokenize on whitespace, but keep braced groups intact even if they contain
 * spaces (`{--header=Authorization: Bearer}` works). Throws on unterminated
 * braces.
 */
function tokenize(signature: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < signature.length) {
    while (i < signature.length && /\s/.test(signature[i] ?? '')) i++
    if (i >= signature.length) break
    if (signature[i] === '{') {
      const end = signature.indexOf('}', i)
      if (end === -1) {
        throw new ConfigError(`parseSignature("${signature}"): unterminated "{"`)
      }
      tokens.push(signature.slice(i, end + 1))
      i = end + 1
    } else {
      let j = i
      while (j < signature.length && !/\s/.test(signature[j] ?? '')) j++
      tokens.push(signature.slice(i, j))
      i = j
    }
  }
  return tokens
}
