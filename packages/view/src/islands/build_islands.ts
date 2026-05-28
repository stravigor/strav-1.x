/**
 * `buildIslands(opts)` — discover `*.vue` files under `inputDir`,
 * generate a self-mounting entry module per island, and bundle each
 * with `Bun.build` + the Vue SFC plugin.
 *
 * Output: one `<Name>.js` file per island in `outputDir`. Each is a
 * standalone ES module that, when loaded by a browser, finds every
 * `<div data-island="Name">` element, parses `data-props` as JSON,
 * and mounts the Vue component with those props.
 *
 * Self-mounting contract — what each `<Name>.js` bundle does:
 *
 *   ```js
 *   import { createApp } from 'vue'
 *   import Component from './<Name>.vue'
 *   for (const el of document.querySelectorAll('[data-island="<Name>"]')) {
 *     const props = JSON.parse(el.getAttribute('data-props') ?? '{}')
 *     createApp(Component, props).mount(el)
 *   }
 *   ```
 *
 *   Apps using a different bundler can match this contract and skip
 *   `buildIslands` entirely — the engine's `@island` directive only
 *   emits the `<div data-island=…>` + `<script type=module>` markup.
 *
 * Vue + `@vue/compiler-sfc` are **optional peer deps**. Apps that
 * use islands install both; the rest of `@strav/view` works without
 * them.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { TemplateError } from '../template_error.ts'
import { vueSfcPlugin } from './vue_plugin.ts'

export interface BuildIslandsOptions {
  /** Directory containing `*.vue` islands. Recursively scanned. */
  inputDir: string
  /** Where to write the bundled `<Name>.js` files. Created if missing. */
  outputDir: string
  /**
   * Minify the output? Defaults to `true`. Set `false` in dev for
   * readable stack traces.
   */
  minify?: boolean
  /**
   * Generate source maps. Defaults to `false`. Useful in dev.
   */
  sourcemap?: boolean
  /**
   * External package names — passed to `Bun.build`. Apps that load
   * Vue from a CDN can set `external: ['vue']` to keep it out of
   * each bundle.
   */
  external?: string[]
}

export interface BuildIslandsResult {
  /** Absolute paths of the bundled `<Name>.js` files. */
  outputs: string[]
  /** Island names that were discovered + bundled, in input order. */
  islands: string[]
}

export async function buildIslands(opts: BuildIslandsOptions): Promise<BuildIslandsResult> {
  const inputDir = resolve(opts.inputDir)
  const outputDir = resolve(opts.outputDir)

  const vueFiles = await discoverVueFiles(inputDir)
  if (vueFiles.length === 0) {
    return { outputs: [], islands: [] }
  }

  await mkdir(outputDir, { recursive: true })

  // Per-island entry modules live in an OS-temp directory so the
  // bundler's `[name]` token maps cleanly to `<island>.js` in
  // `outputDir`. Keeps the output folder clean — no `.entries/`
  // sidecar leaks into apps' static-asset trees.
  const entryDir = await mkdtemp(join(tmpdir(), 'strav-island-entries-'))

  try {
    const islands: string[] = []
    const entryPaths: string[] = []
    const nameToVue: Record<string, string> = {}
    for (const vuePath of vueFiles) {
      const name = islandNameFor(inputDir, vuePath)
      if (nameToVue[name] !== undefined) {
        throw new TemplateError(
          `Duplicate island name '${name}' — two .vue files resolve to the same island ('${nameToVue[name]}' and '${vuePath}').`,
          { context: { name, files: [nameToVue[name], vuePath] } },
        )
      }
      nameToVue[name] = vuePath
      islands.push(name)
      const entryPath = join(entryDir, `${name}.ts`)
      await writeFile(entryPath, selfMountingEntry(name, vuePath), 'utf8')
      entryPaths.push(entryPath)
    }

    const result = await Bun.build({
      entrypoints: entryPaths,
      outdir: outputDir,
      naming: '[name].js',
      target: 'browser',
      minify: opts.minify ?? true,
      sourcemap: opts.sourcemap === true ? 'inline' : 'none',
      external: opts.external,
      plugins: [vueSfcPlugin()],
    })

    if (!result.success) {
      const messages = result.logs.map((l) => l.message ?? String(l)).join('\n')
      throw new TemplateError(`buildIslands failed:\n${messages}`, {
        context: { logs: result.logs.map((l) => l.message) },
      })
    }

    const outputs = islands.map((n) => join(outputDir, `${n}.js`))
    return { outputs, islands }
  } finally {
    // Best-effort cleanup of the temp entry dir.
    await rm(entryDir, { recursive: true, force: true })
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Recursively collect every `.vue` file under `root`. */
async function discoverVueFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // missing or unreadable — caller gets an empty result
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile() && e.name.endsWith('.vue')) {
        out.push(full)
      }
    }
  }
  await walk(root)
  out.sort()
  return out
}

/**
 * Island name from a file path. `resources/ts/islands/LeadKanban.vue`
 * → `LeadKanban`. Nested paths use a dotted form:
 * `resources/ts/islands/charts/Bar.vue` → `charts.Bar`. Apps that
 * want flat names should colocate their .vue files at the root.
 */
function islandNameFor(root: string, file: string): string {
  const rel = relative(root, file)
  const { dir, name } = parsePath(rel)
  if (dir === '') return name
  return `${dir.split(sep).join('.')}.${name}`
}

/**
 * The self-mounting entry-module source. Imports Vue + the component,
 * scans the DOM for `[data-island="<name>"]` elements, hydrates each
 * with the props read from `data-props`.
 */
function selfMountingEntry(name: string, vuePath: string): string {
  // Relative path from the entry file to the .vue file. The entry
  // lives at `<outputDir>/.entries/<name>.entry.ts`, so we go up one
  // directory and reference the absolute path resolved at write time.
  return [
    `// AUTOGENERATED by @strav/view buildIslands(). Do not edit by hand.`,
    `import { createApp } from 'vue'`,
    `import Component from ${JSON.stringify(vuePath)}`,
    ``,
    `function hydrate() {`,
    `  const sel = ${JSON.stringify(`[data-island="${name}"]`)}`,
    `  for (const el of document.querySelectorAll(sel)) {`,
    `    const raw = el.getAttribute('data-props')`,
    `    let props = {}`,
    `    if (raw !== null) { try { props = JSON.parse(raw) } catch (_) { props = {} } }`,
    `    createApp(Component, props).mount(el)`,
    `  }`,
    `}`,
    ``,
    `if (typeof document !== 'undefined') {`,
    `  if (document.readyState === 'loading') {`,
    `    document.addEventListener('DOMContentLoaded', hydrate, { once: true })`,
    `  } else {`,
    `    hydrate()`,
    `  }`,
    `}`,
    `// dirname helper to silence "unused import" warnings if optimisers run:`,
    `void ${JSON.stringify(dirname(vuePath))}`,
    ``,
  ].join('\n')
}
