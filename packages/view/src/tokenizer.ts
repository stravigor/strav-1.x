/**
 * `tokenize(source)` — convert `.strav` source into a `Token[]` for
 * the compiler.
 *
 * Recognised tokens:
 *
 *   - `{{ expr }}`            — escaped interpolation
 *   - `{!! expr !!}`          — raw interpolation
 *   - `{{-- comment --}}`     — comment (skipped, contributes line count)
 *   - `@directive(args)`      — directive with parenthesised args
 *   - `@directive`            — directive with no args (e.g. `@else`,
 *                                `@empty`, `@endif`, `@csrf`)
 *   - any other text          — emitted as a `text` token
 *
 * `@raw ... @endraw` is special: the tokenizer collapses the entire
 * body into a single `text` token so `{{ }}` / `@…` inside the raw
 * block render verbatim.
 *
 * Line tracking: every token carries the 1-based source line it
 * starts on. The compiler / engine use this in `TemplateError`
 * messages.
 *
 * Directives unknown to the frozen set are NOT rejected here — the
 * compiler does that. The tokenizer just sees an `@word` and emits
 * the token; the compiler picks the right rule by name.
 */

import { TemplateError } from './template_error.ts'

export type TokenType = 'text' | 'escaped' | 'raw' | 'directive'

export interface Token {
  type: TokenType
  /**
   * For `text`: the literal text.
   * For `escaped` / `raw`: the expression source between the delimiters.
   * For `directive`: the directive NAME (without `@`); args go on `args`.
   */
  value: string
  /** Args for directive tokens — the source between `(` and the matching `)`. Empty when no parens. */
  args?: string
  /** 1-based line number where the token starts. */
  line: number
}

/**
 * The frozen directive set — the tokenizer only treats `@<word>` as
 * a directive when `<word>` is in this set. This keeps email
 * addresses (`hello@example.com`) and stray `@` symbols safe from
 * accidental directive parsing, AND allows directives like
 * `@endif` to appear immediately after content (`yes@endif`) without
 * needing whitespace as a separator.
 *
 * The compiler validates directive semantics; the tokenizer just
 * needs to know "is this a directive name worth tokenizing."
 */
const DIRECTIVES = new Set([
  'if',
  'elseif',
  'else',
  'endif',
  'for',
  'endfor',
  'each',
  'empty',
  'endeach',
  'extends',
  'section',
  'endsection',
  'set',
  'yield',
  'include',
  'push',
  'endpush',
  'prepend',
  'endprepend',
  'stack',
  'csrf',
  'method',
  'route',
  'asset',
  'island',
  'raw',
  'endraw',
  'escape',
  'component',
  'endcomponent',
])

const RAW_OPEN = 'raw'
const RAW_CLOSE = 'endraw'

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  const len = source.length

  const advanceLines = (slice: string): void => {
    for (let k = 0; k < slice.length; k += 1) {
      if (slice.charCodeAt(k) === 0x0a) line += 1
    }
  }

  // Buffered text — flushed when we hit a recognised marker. Buffering
  // lets us coalesce contiguous text across e.g. an `{{-- comment --}}`
  // boundary so the comment doesn't leave two adjacent text tokens.
  let textBuf = ''
  let textStartLine = line

  const flushText = (): void => {
    if (textBuf.length === 0) return
    tokens.push({ type: 'text', value: textBuf, line: textStartLine })
    textBuf = ''
  }

  while (i < len) {
    // ─── Comments ──────────────────────────────────────────────────────────
    if (source.startsWith('{{--', i)) {
      const close = source.indexOf('--}}', i + 4)
      if (close === -1) {
        throw new TemplateError('Unclosed `{{-- comment --}}` block.', {
          context: { line: textStartLine },
        })
      }
      const block = source.slice(i, close + 4)
      advanceLines(block)
      i = close + 4
      // textBuf carries on — comments don't break runs of text.
      // textStartLine stays put.
      continue
    }

    // ─── Raw interpolation `{!! ... !!}` ──────────────────────────────────
    if (source.startsWith('{!!', i)) {
      flushText()
      const close = source.indexOf('!!}', i + 3)
      if (close === -1) {
        throw new TemplateError('Unclosed `{!! ... !!}` interpolation.', { context: { line } })
      }
      const expr = source.slice(i + 3, close).trim()
      const startLine = line
      advanceLines(source.slice(i, close + 3))
      tokens.push({ type: 'raw', value: expr, line: startLine })
      i = close + 3
      textStartLine = line
      continue
    }

    // ─── Escaped interpolation `{{ ... }}` ────────────────────────────────
    // Must come AFTER `{{--` and `{!!` checks; this is the catch-all
    // for double-braces.
    if (source.startsWith('{{', i)) {
      flushText()
      const close = findMatchingClose(source, i + 2, '}}')
      if (close === -1) {
        throw new TemplateError('Unclosed `{{ ... }}` interpolation.', { context: { line } })
      }
      const expr = source.slice(i + 2, close).trim()
      const startLine = line
      advanceLines(source.slice(i, close + 2))
      tokens.push({ type: 'escaped', value: expr, line: startLine })
      i = close + 2
      textStartLine = line
      continue
    }

    // ─── Directives `@name` / `@name(...)` ────────────────────────────────
    // Recognised only when `@<word>` is in the frozen directive set —
    // see the `DIRECTIVES` set above. Unknown `@words` (including
    // email addresses like `hello@example.com`) fall through to text.
    if (source.charCodeAt(i) === 0x40 /* @ */) {
      const nameStart = i + 1
      let nameEnd = nameStart
      while (nameEnd < len && isWordChar(source.charCodeAt(nameEnd))) nameEnd += 1
      const name = nameEnd > nameStart ? source.slice(nameStart, nameEnd) : ''
      if (name !== '' && DIRECTIVES.has(name)) {
        const startLine = line

        // Optional argument list — only if the very next char is `(`.
        let args: string | undefined
        let after = nameEnd
        if (after < len && source.charCodeAt(after) === 0x28 /* ( */) {
          const argClose = findMatchingParen(source, after)
          if (argClose === -1) {
            throw new TemplateError(`Unclosed argument list on @${name}.`, {
              context: { line: startLine },
            })
          }
          args = source.slice(after + 1, argClose)
          advanceLines(source.slice(i, argClose + 1))
          after = argClose + 1
        } else {
          advanceLines(source.slice(i, after))
        }

        // Special-case `@raw` — gobble until `@endraw` as one text token.
        if (name === RAW_OPEN) {
          flushText()
          const closeIdx = findRawClose(source, after)
          if (closeIdx === -1) {
            throw new TemplateError('Unclosed `@raw` block — missing `@endraw`.', {
              context: { line: startLine },
            })
          }
          const body = source.slice(after, closeIdx)
          advanceLines(body)
          tokens.push({ type: 'text', value: body, line: startLine })
          // Skip past `@endraw`.
          i = closeIdx + '@endraw'.length
          textStartLine = line
          continue
        }
        if (name === RAW_CLOSE) {
          throw new TemplateError('`@endraw` without matching `@raw`.', {
            context: { line: startLine },
          })
        }

        flushText()
        const token: Token = { type: 'directive', value: name, line: startLine }
        if (args !== undefined) token.args = args
        tokens.push(token)
        i = after
        textStartLine = line
        continue
      }
      // `@` followed by non-word — fall through and treat as text.
    }

    // ─── Plain text byte ──────────────────────────────────────────────────
    const ch = source.charCodeAt(i)
    if (ch === 0x0a) {
      textBuf += '\n'
      line += 1
    } else {
      textBuf += source[i]
    }
    i += 1
  }

  flushText()
  return tokens
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isWordChar(code: number): boolean {
  // Underscore is intentionally NOT a directive char in the frozen set;
  // every directive is plain ASCII lowercase. Allow digits because
  // future directives might use them (none today).
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)
}

/**
 * Find the matching closing delimiter (`}}` for `{{`) starting from
 * `from`. Respects single + double quoted strings so `{{ "}}" }}`
 * doesn't terminate early.
 */
function findMatchingClose(source: string, from: number, close: string): number {
  let i = from
  let quote: number | null = null
  while (i < source.length) {
    const ch = source.charCodeAt(i)
    if (quote === null) {
      if (ch === 0x27 /* ' */ || ch === 0x22 /* " */ || ch === 0x60 /* ` */) {
        quote = ch
      } else if (source.startsWith(close, i)) {
        return i
      }
    } else {
      if (ch === 0x5c /* \ */) {
        i += 2
        continue
      }
      if (ch === quote) quote = null
    }
    i += 1
  }
  return -1
}

/**
 * Given that `source[start]` is `(`, find the matching `)`. Respects
 * nested parens, quoted strings, and brackets — so directive args like
 * `route('users.show', { id: user.id })` work.
 */
function findMatchingParen(source: string, start: number): number {
  let depth = 0
  let i = start
  let quote: number | null = null
  while (i < source.length) {
    const ch = source.charCodeAt(i)
    if (quote !== null) {
      if (ch === 0x5c) {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === 0x27 || ch === 0x22 || ch === 0x60) {
      quote = ch
    } else if (ch === 0x28) {
      depth += 1
    } else if (ch === 0x29) {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/**
 * Find the position of `@endraw` (start of `@`) AFTER `from`. Returns
 * -1 if not found. Used to gobble `@raw ... @endraw` as a literal
 * block. No nested `@raw` support — the first `@endraw` closes the
 * current block.
 *
 * Trailing-context check: `@endraw` must be followed by a non-word
 * char (or EOF) so we don't match `@endrawx`. Leading-context isn't
 * required — `@raw...stuff@endraw` with no separator is fine.
 */
function findRawClose(source: string, from: number): number {
  const needle = '@endraw'
  let i = from
  while (i < source.length) {
    const idx = source.indexOf(needle, i)
    if (idx === -1) return -1
    const after = idx + needle.length
    if (after >= source.length || !isWordChar(source.charCodeAt(after))) {
      return idx
    }
    i = idx + 1
  }
  return -1
}
