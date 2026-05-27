/**
 * Path-based redaction for structured log fields.
 *
 * Compiles a list of dotted-path expressions into a single redactor function.
 * The redactor returns a *clone* of the input with matching values replaced
 * by the censor string — the original object is never mutated.
 *
 * Supported path syntax (per `spec/errors-and-logging.md`):
 *   - `password`             — exact top-level key
 *   - `headers.authorization` — exact nested path
 *   - `*.password`           — exactly one wildcard segment
 *   - `**.token`             — recursive wildcard (zero or more segments)
 *
 * We don't lean on Pino's built-in `redact` because Pino doesn't support the
 * recursive `**` form the spec calls out, and we want one redactor that works
 * the same way across every channel.
 */

const DEFAULT_CENSOR = '[REDACTED]'

type Segment = { kind: 'literal'; value: string } | { kind: 'one' } | { kind: 'deep' }

interface CompiledPath {
  segments: readonly Segment[]
  source: string
}

export interface RedactorOptions {
  paths?: readonly string[]
  censor?: string
}

export type Redactor = <T>(value: T) => T

export function compileRedactor(options: RedactorOptions = {}): Redactor {
  const paths = (options.paths ?? []).map(compilePath)
  const censor = options.censor ?? DEFAULT_CENSOR

  if (paths.length === 0) {
    return ((value) => value) as Redactor
  }

  const apply = <T>(value: T): T => walk(value, paths, censor, 0) as T
  return apply as Redactor
}

function compilePath(source: string): CompiledPath {
  if (source.length === 0) {
    throw new Error('Logger redact: empty path expression.')
  }
  const parts = source.split('.')
  const segments: Segment[] = parts.map((part) => {
    if (part === '*') return { kind: 'one' }
    if (part === '**') return { kind: 'deep' }
    return { kind: 'literal', value: part }
  })
  return { segments, source }
}

/**
 * Walk `value` cloning objects/arrays along the way; replace any value whose
 * path matches at least one compiled expression. Primitives and unknown types
 * (Date, Buffer, etc.) are returned as-is — we only descend into plain
 * objects and arrays.
 */
function walk(
  value: unknown,
  paths: readonly CompiledPath[],
  censor: string,
  depth: number,
): unknown {
  if (depth > 32) return value // cycle / pathological-depth guard
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item, idx) => walkChild(item, paths, censor, String(idx), depth))
  }
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walkChild(child, paths, censor, key, depth)
  }
  return out
}

function walkChild(
  child: unknown,
  paths: readonly CompiledPath[],
  censor: string,
  key: string,
  depth: number,
): unknown {
  const matching: CompiledPath[] = []
  let terminalMatch = false
  for (const p of paths) {
    const next = advance(p.segments, key)
    if (next === 'terminal') {
      terminalMatch = true
    } else if (next.length > 0) {
      matching.push({ segments: next, source: p.source })
    }
  }
  if (terminalMatch) return censor
  if (matching.length === 0) return walk(child, [], censor, depth + 1)
  return walk(child, matching, censor, depth + 1)
}

/**
 * Step a compiled path forward by one segment. Returns the remaining segments
 * (or `'terminal'` if this match consumes the last segment) or `[]` for no
 * match. `**` is preserved so it can absorb additional levels.
 */
function advance(segments: readonly Segment[], key: string): readonly Segment[] | 'terminal' {
  if (segments.length === 0) return []
  const [head, ...rest] = segments
  if (head === undefined) return []

  if (head.kind === 'deep') {
    // `**` may match zero segments (try `rest` against `key`) or one+ segments
    // (keep the full `[**, ...rest]` pattern so deeper levels can still match).
    const skipped = advance(rest, key)
    if (skipped === 'terminal') return 'terminal'
    // Always preserve the full pattern so the deep wildcard can keep descending,
    // even when this level didn't yield a refined match.
    return segments
  }

  const matched = head.kind === 'one' || (head.kind === 'literal' && head.value === key)
  if (!matched) return []
  return rest.length === 0 ? 'terminal' : rest
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
