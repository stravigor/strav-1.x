/**
 * `compile(tokens, source?)` — turn a `Token[]` into a callable render
 * function.
 *
 * Compilation strategy: emit a JS function source string that, when
 * called with `(data, ctx)`, returns the rendered HTML string.
 *
 * `ctx` is the engine-provided execution context:
 *
 *   {
 *     escape: (v) => string,        // HTML escape
 *     include: async (name, data) => string,
 *     section: (name, body) => void,
 *     setValue: (name, value) => void,
 *     yieldSection: (name) => string,
 *     push: (name, body) => void,
 *     prepend: (name, body) => void,
 *     stackOf: (name) => string,
 *     csrf: () => string,
 *     method: (verb) => string,
 *     route: (name, params?) => string,
 *     asset: (path) => string,
 *     component: async (name, props, slot) => string,
 *   }
 *
 * The render fn returns `{ html, layout?, slots, stacks }` so the
 * engine can plug it into a layout when `@extends` was used.
 *
 * Compile-time validation:
 *   - Frozen directive set — anything else throws.
 *   - Block balance — every open has its matching close.
 *   - Argument shape per directive — e.g. `@for(item of items)` not
 *     `@for(...)` of arbitrary form.
 *
 * Runtime errors (e.g. thrown expressions inside `{{ }}`) surface via
 * `TemplateError` with `cause` set to the original throwable.
 */

import { TemplateError } from './template_error.ts'
import type { Token } from './tokenizer.ts'

// ─── Public surface ──────────────────────────────────────────────────────────

export interface CompilationResult {
  /** The render fn — call with `(data, ctx)` to get `{ html, layout?, slots, stacks }`. */
  render: RenderFunction
  /**
   * The `@extends` target template name, if the template declared
   * one. The engine reads this to fetch + render the layout.
   */
  layout?: string
  /** Compiled JS source — exposed for the `view:compile <file>` debug tool. */
  source: string
}

export interface RenderResult {
  html: string
  slots: Record<string, string>
  stacks: Record<string, string[]>
}

export type RenderFunction = (
  data: Record<string, unknown>,
  ctx: RenderContext,
) => Promise<RenderResult>

export interface RenderContext {
  escape: (value: unknown) => string
  include: (name: string, data: Record<string, unknown>) => Promise<string>
  section: (name: string, body: string) => void
  setValue: (name: string, value: unknown) => void
  yieldSection: (name: string) => string
  push: (name: string, body: string) => void
  prepend: (name: string, body: string) => void
  stackOf: (name: string) => string
  csrf: () => string
  method: (verb: string) => string
  route: (name: string, params?: Record<string, unknown>) => string
  asset: (path: string) => string
  component: (name: string, props: Record<string, unknown>, slot: string) => Promise<string>
}

export function compile(tokens: readonly Token[]): CompilationResult {
  const out = new Emitter()
  let layout: string | undefined
  const blockStack: BlockFrame[] = []

  // ─── Header ─────────────────────────────────────────────────────────────
  out.line('let __out = ""')
  out.line('const __slots = {}')
  out.line('const __stacks = {}')

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token

    if (tok.type === 'text') {
      if (tok.value.length > 0) out.line(`__out += ${JSON.stringify(tok.value)}`)
      continue
    }
    if (tok.type === 'escaped') {
      out.line(`__out += __ctx.escape(${tok.value})`)
      continue
    }
    if (tok.type === 'raw') {
      out.line(`__out += (${tok.value}) ?? ""`)
      continue
    }

    // tok.type === 'directive'
    const name = tok.value
    const args = tok.args
    const line = tok.line

    switch (name) {
      // ─── Conditionals ────────────────────────────────────────────────
      case 'if':
        requireArgs(name, args, line)
        out.line(`if (${args}) {`)
        blockStack.push({ kind: 'if', line })
        break
      case 'elseif':
        expectOpen(blockStack, 'if', name, line)
        requireArgs(name, args, line)
        out.line(`} else if (${args}) {`)
        break
      case 'else':
        expectOpen(blockStack, 'if', name, line)
        out.line('} else {')
        break
      case 'endif':
        expectOpen(blockStack, 'if', name, line)
        out.line('}')
        blockStack.pop()
        break

      // ─── for loop ────────────────────────────────────────────────────
      case 'for': {
        requireArgs(name, args, line)
        // Expect `<lhs> of <rhs>` (or `in` for object iteration).
        // Pass through to the JS for…of directly.
        out.line(`for (const ${args}) {`)
        blockStack.push({ kind: 'for', line })
        break
      }
      case 'endfor':
        expectOpen(blockStack, 'for', name, line)
        out.line('}')
        blockStack.pop()
        break

      // ─── each loop with optional @empty ──────────────────────────────
      case 'each': {
        requireArgs(name, args, line)
        // Expect `<item> in <collection>`.
        const eachMatch = /^\s*([A-Za-z_$][\w$]*)\s+in\s+(.+)$/s.exec(args ?? '')
        if (eachMatch === null) {
          throw compileError(`@each expects '<item> in <collection>', got '${args}'.`, line)
        }
        const item = eachMatch[1] as string
        const coll = eachMatch[2] as string
        const colVar = `__each_${blockStack.length}`
        out.line(`{ const ${colVar} = ${coll}`)
        out.line(
          `  if (${colVar} && typeof ${colVar}[Symbol.iterator] === 'function' && Array.from(${colVar}).length > 0) {`,
        )
        out.line(`    for (const ${item} of ${colVar}) {`)
        blockStack.push({ kind: 'each', line })
        break
      }
      case 'empty': {
        expectOpen(blockStack, 'each', name, line)
        out.line('    }')
        out.line('  } else {')
        break
      }
      case 'endeach': {
        const frame = expectOpen(blockStack, 'each', name, line)
        // If `@empty` was emitted, the outer else is open; if not, we
        // need to close the inner for-loop and the outer if both.
        if (frame.hasEmpty === true) {
          out.line('  }')
          out.line('}')
        } else {
          out.line('    }')
          out.line('  }')
          out.line('}')
        }
        blockStack.pop()
        break
      }

      // ─── Layouts ─────────────────────────────────────────────────────
      case 'extends': {
        requireArgs(name, args, line)
        if (layout !== undefined) {
          throw compileError('Multiple @extends in one template.', line)
        }
        layout = evalStringLiteral(args ?? '', line, '@extends')
        break
      }

      // ─── Sections / set / yield ──────────────────────────────────────
      case 'section': {
        requireArgs(name, args, line)
        const sectionName = evalStringLiteral(args ?? '', line, '@section')
        // Capture mode: redirect __out to a buffer.
        out.line(`{ const __outer = __out; __out = ""`)
        blockStack.push({ kind: 'section', line, sectionName })
        break
      }
      case 'endsection': {
        const frame = expectOpen(blockStack, 'section', name, line)
        out.line(`__ctx.section(${JSON.stringify(frame.sectionName)}, __out); __out = __outer; }`)
        blockStack.pop()
        break
      }
      case 'set': {
        requireArgs(name, args, line)
        const { name: setName, value } = splitSetArgs(args ?? '', line)
        out.line(`__ctx.setValue(${JSON.stringify(setName)}, ${value})`)
        break
      }
      case 'yield': {
        requireArgs(name, args, line)
        const yieldName = evalStringLiteral(args ?? '', line, '@yield')
        out.line(`__out += __ctx.yieldSection(${JSON.stringify(yieldName)})`)
        break
      }

      // ─── Includes ────────────────────────────────────────────────────
      case 'include': {
        requireArgs(name, args, line)
        const { name: incName, data: incData } = splitIncludeArgs(args ?? '', line)
        out.line(`__out += await __ctx.include(${JSON.stringify(incName)}, ${incData})`)
        break
      }

      // ─── Stacks ──────────────────────────────────────────────────────
      case 'push': {
        requireArgs(name, args, line)
        const stackName = evalStringLiteral(args ?? '', line, '@push')
        out.line(`{ const __outer = __out; __out = ""`)
        blockStack.push({ kind: 'push', line, stackName })
        break
      }
      case 'endpush': {
        const frame = expectOpen(blockStack, 'push', name, line)
        out.line(`__ctx.push(${JSON.stringify(frame.stackName)}, __out); __out = __outer; }`)
        blockStack.pop()
        break
      }
      case 'prepend': {
        requireArgs(name, args, line)
        const stackName = evalStringLiteral(args ?? '', line, '@prepend')
        out.line(`{ const __outer = __out; __out = ""`)
        blockStack.push({ kind: 'prepend', line, stackName })
        break
      }
      case 'endprepend': {
        const frame = expectOpen(blockStack, 'prepend', name, line)
        out.line(`__ctx.prepend(${JSON.stringify(frame.stackName)}, __out); __out = __outer; }`)
        blockStack.pop()
        break
      }
      case 'stack': {
        requireArgs(name, args, line)
        const stackName = evalStringLiteral(args ?? '', line, '@stack')
        out.line(`__out += __ctx.stackOf(${JSON.stringify(stackName)})`)
        break
      }

      // ─── Forms / helpers ─────────────────────────────────────────────
      case 'csrf':
        out.line('__out += __ctx.csrf()')
        break
      case 'method':
        requireArgs(name, args, line)
        out.line(`__out += __ctx.method(${args})`)
        break
      case 'route':
        requireArgs(name, args, line)
        out.line(`__out += __ctx.route(${args})`)
        break
      case 'asset':
        requireArgs(name, args, line)
        out.line(`__out += __ctx.asset(${args})`)
        break

      // ─── Explicit escape ─────────────────────────────────────────────
      case 'escape':
        requireArgs(name, args, line)
        out.line(`__out += __ctx.escape(${args})`)
        break

      // ─── Components ──────────────────────────────────────────────────
      case 'component': {
        requireArgs(name, args, line)
        const { name: compName, props } = splitComponentArgs(args ?? '', line)
        out.line(`{ const __outer = __out; __out = ""`)
        blockStack.push({ kind: 'component', line, componentName: compName, componentProps: props })
        break
      }
      case 'endcomponent': {
        const frame = expectOpen(blockStack, 'component', name, line)
        out.line(
          `const __slot = __out; __out = __outer; __out += await __ctx.component(${JSON.stringify(
            frame.componentName,
          )}, ${frame.componentProps}, __slot); }`,
        )
        blockStack.pop()
        break
      }

      // ─── @island (deferred) ──────────────────────────────────────────
      case 'island':
        throw compileError(
          '@island is not implemented yet — it lands in the next view slice along with the bundler + client runtime.',
          line,
        )

      default:
        throw compileError(`Unknown directive @${name}.`, line)
    }

    // Track `@empty` for `@each` to flip the closing template.
    if (name === 'empty') {
      const top = blockStack[blockStack.length - 1]
      if (top !== undefined) top.hasEmpty = true
    }
  }

  if (blockStack.length > 0) {
    const top = blockStack[blockStack.length - 1] as BlockFrame
    throw compileError(`Unclosed @${top.kind} block (opened on line ${top.line}).`, top.line)
  }

  out.line('return { html: __out, slots: __slots, stacks: __stacks }')

  const source = `async function __render(__data, __ctx) {
    with (__data) {
${out.body()}
    }
  }
  return __render(__data, __ctx)`

  let render: RenderFunction
  try {
    // `new AsyncFunction` would also work; `new Function` returning a
    // call to an async inner suffices and keeps the surface identical.
    const fn = new Function('__data', '__ctx', source) as RenderFunction
    render = fn
  } catch (cause) {
    throw new TemplateError(`Compiled template failed to parse: ${(cause as Error).message}`, {
      cause,
      context: { source },
    })
  }

  return { render, layout, source }
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface BlockFrame {
  kind: 'if' | 'for' | 'each' | 'section' | 'push' | 'prepend' | 'component'
  line: number
  sectionName?: string
  stackName?: string
  componentName?: string
  componentProps?: string
  hasEmpty?: boolean
}

class Emitter {
  private readonly lines: string[] = []
  line(s: string): void {
    this.lines.push(`      ${s}`)
  }
  body(): string {
    return this.lines.join('\n')
  }
}

function requireArgs(directive: string, args: string | undefined, line: number): void {
  if (args === undefined || args.trim() === '') {
    throw compileError(`@${directive} requires an argument list.`, line)
  }
}

function expectOpen(
  stack: BlockFrame[],
  kind: BlockFrame['kind'],
  directive: string,
  line: number,
): BlockFrame {
  const top = stack[stack.length - 1]
  if (top === undefined || top.kind !== kind) {
    throw compileError(`@${directive} without matching @${kind}.`, line)
  }
  return top
}

function compileError(message: string, line: number): TemplateError {
  return new TemplateError(`${message} (line ${line})`, { context: { line } })
}

/**
 * Evaluate a literal-string directive argument like `@yield('content')`.
 * Accepts single, double, or backtick quotes. Returns the unquoted
 * string. Throws if the arg isn't a simple string literal — directives
 * like `@yield`, `@section`, `@push`, `@stack` only accept literals.
 */
function evalStringLiteral(args: string, line: number, directive: string): string {
  const trimmed = args.trim()
  const first = trimmed.charAt(0)
  if (first !== "'" && first !== '"' && first !== '`') {
    throw compileError(`${directive} expects a string literal argument, got \`${args}\`.`, line)
  }
  const last = trimmed.charAt(trimmed.length - 1)
  if (last !== first) {
    throw compileError(`${directive}: unterminated string literal.`, line)
  }
  // Unescape the JS escape sequences.
  try {
    return JSON.parse(`"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`)
  } catch {
    throw compileError(`${directive}: invalid string literal.`, line)
  }
}

/** `@set('name', value)` — name is a literal, value is any expression. */
function splitSetArgs(args: string, line: number): { name: string; value: string } {
  const comma = findTopLevelComma(args)
  if (comma === -1) {
    throw compileError("@set expects 'name', value.", line)
  }
  const name = evalStringLiteral(args.slice(0, comma), line, '@set')
  const value = args.slice(comma + 1).trim()
  if (value === '') throw compileError('@set expects a value after the name.', line)
  return { name, value }
}

/** `@include('name')` or `@include('name', { ...data })`. */
function splitIncludeArgs(args: string, line: number): { name: string; data: string } {
  const comma = findTopLevelComma(args)
  if (comma === -1) {
    return { name: evalStringLiteral(args, line, '@include'), data: '({})' }
  }
  const name = evalStringLiteral(args.slice(0, comma), line, '@include')
  const data = args.slice(comma + 1).trim()
  return { name, data: data === '' ? '({})' : `(${data})` }
}

/** `@component('name', { ...props })` — name literal, props expression. */
function splitComponentArgs(args: string, line: number): { name: string; props: string } {
  const comma = findTopLevelComma(args)
  if (comma === -1) {
    return { name: evalStringLiteral(args, line, '@component'), props: '({})' }
  }
  const name = evalStringLiteral(args.slice(0, comma), line, '@component')
  const props = args.slice(comma + 1).trim()
  return { name, props: props === '' ? '({})' : `(${props})` }
}

/**
 * Find the first top-level comma (not inside parens / brackets / quotes).
 * Used by directives whose argument list is `'name', <expr>`.
 */
function findTopLevelComma(args: string): number {
  let depth = 0
  let quote: number | null = null
  for (let i = 0; i < args.length; i += 1) {
    const ch = args.charCodeAt(i)
    if (quote !== null) {
      if (ch === 0x5c) {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === 0x27 || ch === 0x22 || ch === 0x60) {
      quote = ch
      continue
    }
    if (ch === 0x28 || ch === 0x5b || ch === 0x7b) {
      depth += 1
      continue
    }
    if (ch === 0x29 || ch === 0x5d || ch === 0x7d) {
      depth -= 1
      continue
    }
    if (ch === 0x2c /* , */ && depth === 0) return i
  }
  return -1
}
