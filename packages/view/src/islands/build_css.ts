/**
 * `buildCss(opts)` — bundle one or more CSS entry files into
 * `outputDir` via `Bun.build`.
 *
 * Bun's bundler has supported `.css` entrypoints since 1.1: it walks
 * `@import`s, inlines them, drops the per-file source maps when asked,
 * and minifies. That removes any need for the `sass`-driven pipeline
 * the 0.x island builder shipped — apps that want Sass / PostCSS /
 * Tailwind bring those tools (or a CSS file already processed by them)
 * and we just bundle + emit.
 *
 * Output naming preserves the source's basename:
 *   `resources/css/app.css` → `<outputDir>/app.css`.
 *
 * The wrapper is intentionally thin — apps reaching for advanced
 * pipelines (Lightning CSS, Tailwind JIT, PostCSS plugins) should call
 * `Bun.build` directly and aren't worse off than they'd be without
 * this helper.
 */

import { mkdir } from 'node:fs/promises'
import { parse as parsePath, resolve } from 'node:path'
import { TemplateError } from '../template_error.ts'

/**
 * One entry produces one output file. `name` is the entry key the
 * template uses with `@css('name')`; `input` is the absolute path on
 * disk; `output` is the bundled filename inside `outputDir`.
 */
export interface CssEntry {
  name: string
  input: string
  /** Output filename (defaults to `<name>.css`). */
  output?: string
}

export interface BuildCssOptions {
  /**
   * CSS entries. Three shapes accepted:
   *
   *   - `string[]`         — auto-named from the file basename.
   *   - `Record<string,string>` — explicit name keys (e.g. `{ app:
   *     'resources/css/app.css', admin: 'resources/css/admin.css' }`).
   *   - `CssEntry[]`       — fully explicit, including custom output
   *     filenames.
   *
   * The array form preserves order — useful when the consuming
   * template emits all entries via `@css` (order matters for the
   * cascade).
   */
  inputs: readonly string[] | Record<string, string> | readonly CssEntry[]
  /** Where bundled CSS lands. Created if missing. */
  outputDir: string
  /** Minify the output. Default `true`. */
  minify?: boolean
  /** Inline source maps. Default `false`. */
  sourcemap?: boolean
}

export interface BuildCssResult {
  /** Absolute paths of every emitted CSS file, in input order. */
  outputs: string[]
  /** Per-entry breakdown: name → absolute output path. */
  entries: Array<{ name: string; output: string }>
}

/** Normalise the union-typed `inputs` field down to an ordered list. */
export function normaliseCssEntries(
  inputs: BuildCssOptions['inputs'],
): Array<{ name: string; input: string; output: string }> {
  const out: Array<{ name: string; input: string; output: string }> = []
  if (Array.isArray(inputs)) {
    for (const entry of inputs) {
      if (typeof entry === 'string') {
        const abs = resolve(entry)
        const name = parsePath(abs).name
        out.push({ name, input: abs, output: `${name}.css` })
      } else {
        const e = entry as CssEntry
        const abs = resolve(e.input)
        out.push({ name: e.name, input: abs, output: e.output ?? `${e.name}.css` })
      }
    }
  } else {
    for (const [name, input] of Object.entries(inputs)) {
      out.push({ name, input: resolve(input), output: `${name}.css` })
    }
  }
  return out
}

export async function buildCss(opts: BuildCssOptions): Promise<BuildCssResult> {
  const outputDir = resolve(opts.outputDir)
  await mkdir(outputDir, { recursive: true })

  const entries = normaliseCssEntries(opts.inputs)
  if (entries.length === 0) {
    return { outputs: [], entries: [] }
  }

  const outputs: string[] = []
  const named: Array<{ name: string; output: string }> = []

  // One `Bun.build` call per entry so `naming` can hold each file's
  // output filename — the bundler's `[name]` token then produces
  // predictable sibling output.
  for (const entry of entries) {
    let result: Awaited<ReturnType<typeof Bun.build>>
    try {
      result = await Bun.build({
        entrypoints: [entry.input],
        outdir: outputDir,
        naming: entry.output,
        target: 'browser',
        minify: opts.minify ?? true,
        sourcemap: opts.sourcemap === true ? 'inline' : 'none',
      })
    } catch (cause) {
      const errors = extractBunBuildMessages(cause)
      throw new TemplateError(
        `buildCss: Bun.build threw for '${entry.input}' — ${errors.length > 0 ? errors.join('\n') : (cause as Error).message ?? String(cause)}`,
        { cause, context: { input: entry.input, errors } },
      )
    }

    if (!result.success) {
      const messages = result.logs.map((l) => l.message ?? String(l)).join('\n')
      throw new TemplateError(
        `buildCss: '${entry.input}' failed:\n${messages.length > 0 ? messages : '(no diagnostic)'}`,
        { context: { input: entry.input, logs: result.logs.map((l) => l.message) } },
      )
    }

    const outPath = resolve(outputDir, entry.output)
    outputs.push(outPath)
    named.push({ name: entry.name, output: outPath })
  }

  return { outputs, entries: named }
}

function extractBunBuildMessages(cause: unknown): string[] {
  if (cause === null || typeof cause !== 'object') return []
  const c = cause as { errors?: unknown; logs?: unknown }
  const collected: string[] = []
  const list = Array.isArray(c.errors) ? c.errors : Array.isArray(c.logs) ? c.logs : []
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'string') collected.push(entry)
    else if (typeof entry === 'object' && 'message' in entry) {
      collected.push(String((entry as { message: unknown }).message))
    } else {
      collected.push(String(entry))
    }
  }
  return collected
}
