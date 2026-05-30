/**
 * `buildIslands(opts)` — bundle every `.vue` island under `inputDir`
 * into a single self-mounting `islands.js`.
 *
 * One Vue app, many islands via `<Teleport>`. The generated entry
 * creates ONE `createApp(Root)` where `Root` renders a `<Teleport>`
 * per `[data-island]` element it finds in the DOM. Every island
 * shares the same app context, so:
 *
 *   - `setup.ts` (or `setup.js`) at the root of `inputDir` is run
 *     ONCE on the shared app — `app.use(createPinia())`, router
 *     installs, etc.
 *   - Pinia / provide-inject / global directives flow across
 *     islands. A store mutation in one island's `<script setup>` is
 *     reactive in another's.
 *
 * The trade-off vs. per-island bundles: every page loads the same
 * `islands.js` even when only one island is on the page. For apps
 * targeted by Strav (server-rendered pages with a small bounded set
 * of interactive islands), this is the right default — shared state
 * is worth the predictable single download. Apps with dozens of
 * rarely-co-occurring islands can split manually.
 *
 * Output:
 *   `<outputDir>/islands.js` — the single ES-module bundle. Apps
 *   load it via `<script type="module" src="…/islands.js" defer>`
 *   in their layout (typically inside `<head>` or before `</body>`).
 *
 * Optional peer deps:
 *   `vue` + `@vue/compiler-sfc`. Apps using islands install both;
 *   the rest of `@strav/view` works without them.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { TemplateError } from '../template_error.ts'
import { vueSfcPlugin } from './vue_plugin.ts'

/**
 * One island source — a directory of `.vue` files plus an optional
 * namespace that prefixes every component name from that source.
 *
 * Modular apps organise islands per module (`app/modules/auth/islands`,
 * `app/modules/billing/islands`) and pass each as a source with a
 * unique namespace. Component names then look like `auth.LoginForm`,
 * `billing.Checkout` in templates — collision-proof, route-aware.
 *
 * At most one source may omit `namespace` — that's the host app's
 * anonymous "root" islands. Components from it use their bare
 * filename (`Counter`). Every other source must declare a namespace.
 */
export interface IslandSource {
  /** Directory containing `*.vue` islands. Recursively scanned. */
  inputDir: string
  /**
   * Optional namespace prefix. When set, every island name from this
   * source is emitted as `<namespace>.<originalName>`. Templates
   * reference it as `@island('<namespace>.<name>', { ... })`.
   */
  namespace?: string
}

export interface BuildIslandsOptions {
  /**
   * Directory containing `*.vue` islands — the single-source
   * shorthand. Use `sources` instead for modular apps with multiple
   * island trees.
   *
   * Mutually exclusive with `sources`. When both are set, `sources`
   * wins.
   */
  inputDir?: string
  /**
   * Multiple island sources merged into a single bundle. Each source
   * contributes `.vue` files and any root-level `setup.*` to the
   * shared Vue app. Useful when the host app organises islands per
   * module, or when vendor packages ship their own islands.
   */
  sources?: readonly IslandSource[]
  /**
   * Where to write the bundled `islands.js`. Created if missing.
   * Most apps point this at `public/assets/islands/` so the file
   * is served as a static asset.
   */
  outputDir: string
  /** Minify the output? Default `true`. Disable for dev. */
  minify?: boolean
  /** Inline source maps. Default `false`. */
  sourcemap?: boolean
  /**
   * External package names passed to `Bun.build`. Apps loading Vue
   * from a CDN set `external: ['vue']` to keep it out of the
   * bundle.
   */
  external?: string[]
  /**
   * Override the output filename (default `'islands.js'`). Apps that
   * want content-hashed names for cache busting pass the hashed
   * filename and rewrite their layout's `<script src>` accordingly.
   */
  filename?: string
}

export interface BuildIslandsResult {
  /** Absolute path of the single bundled file. */
  output: string
  /** Islands that were discovered + bundled, in input order. */
  islands: string[]
  /** Absolute paths of `setup.*` files that were applied. */
  setups: string[]
}

const SETUP_FILENAME_RE = /^setup(\..+)?\.(ts|js|mts|mjs)$/

export async function buildIslands(opts: BuildIslandsOptions): Promise<BuildIslandsResult> {
  if (opts.inputDir === undefined && opts.sources === undefined) {
    throw new TemplateError(
      'buildIslands: pass either `inputDir` (single source) or `sources` (multi-source).',
    )
  }

  // Normalise: turn the single-`inputDir` form into a one-source list
  // so the rest of the pipeline only deals with the multi-source shape.
  const sources: readonly IslandSource[] =
    opts.sources !== undefined
      ? opts.sources
      : [{ inputDir: opts.inputDir as string }]

  // At most one anonymous (no namespace) source.
  const anon = sources.filter((s) => s.namespace === undefined || s.namespace === '')
  if (anon.length > 1) {
    throw new TemplateError(
      `buildIslands: at most one source may omit \`namespace\`. Got ${anon.length} anonymous sources.`,
      { context: { anonymousSources: anon.map((s) => s.inputDir) } },
    )
  }
  // Namespace uniqueness.
  const seenNs = new Set<string>()
  for (const s of sources) {
    if (s.namespace === undefined || s.namespace === '') continue
    if (seenNs.has(s.namespace)) {
      throw new TemplateError(
        `buildIslands: duplicate namespace '${s.namespace}' across sources.`,
        { context: { namespace: s.namespace } },
      )
    }
    seenNs.add(s.namespace)
  }

  const outputDir = resolve(opts.outputDir)
  const filename = opts.filename ?? 'islands.js'

  await mkdir(outputDir, { recursive: true })

  // Discover every source in parallel, then merge.
  const perSource = await Promise.all(
    sources.map(async (src) => {
      const abs = resolve(src.inputDir)
      const discovered = await discoverInputs(abs)
      return { absDir: abs, namespace: src.namespace, ...discovered }
    }),
  )

  const islands: Array<{ name: string; path: string }> = []
  const setupFiles: string[] = []
  const seenNames = new Map<string, string>()

  for (const src of perSource) {
    for (const path of src.vueFiles) {
      const bare = islandNameFor(src.absDir, path)
      const name =
        src.namespace !== undefined && src.namespace !== ''
          ? `${src.namespace}.${bare}`
          : bare
      const existing = seenNames.get(name)
      if (existing !== undefined) {
        throw new TemplateError(
          `Duplicate island name '${name}' — two .vue files resolve to the same island ('${existing}' and '${path}').`,
          { context: { name, files: [existing, path] } },
        )
      }
      seenNames.set(name, path)
      islands.push({ name, path })
    }
    setupFiles.push(...src.setupFiles)
  }
  // Stable ordering for setup files across all sources.
  setupFiles.sort()

  if (islands.length === 0) {
    return { output: '', islands: [], setups: [] }
  }

  // Write the virtual entry inside the FIRST source's directory, NOT
  // `os.tmpdir()` — when Bun.build resolves `import 'vue'` from the
  // synthetic entry, it walks up the file's directory tree looking
  // for `node_modules/`. An entry under `/tmp` lands outside the
  // project root and resolves nothing; an entry under a project
  // source dir walks up into the app's `node_modules/vue/` cleanly.
  const entryRoot = perSource[0]?.absDir ?? resolve(opts.inputDir ?? '.')
  const entryDir = await mkdtemp(join(entryRoot, '.strav-build-entry-'))
  try {
    const entryName = parsePath(filename).name
    const entryPath = join(entryDir, `${entryName}.ts`)
    await writeFile(entryPath, generateEntry(islands, setupFiles), 'utf8')

    let result: Awaited<ReturnType<typeof Bun.build>>
    try {
      result = await Bun.build({
        entrypoints: [entryPath],
        outdir: outputDir,
        naming: filename,
        target: 'browser',
        minify: opts.minify ?? true,
        sourcemap: opts.sourcemap === true ? 'inline' : 'none',
        external: opts.external,
        plugins: [vueSfcPlugin()],
      })
    } catch (cause) {
      // Bun.build throws (rather than returning `{ success: false }`)
      // for critical errors — missing peer deps, a plugin throwing in
      // `setup`, a syntax error inside the synthetic entry. The
      // `cause.message` is the generic `"Bundle failed"`; the real
      // diagnostics live on `.errors` / `.logs`. Surface both so the
      // CLI prints something the user can act on.
      const errors = extractBunBuildMessages(cause)
      throw new TemplateError(
        `buildIslands: Bun.build threw — ${errors.length > 0 ? errors.join('\n') : (cause as Error).message ?? String(cause)}`,
        { cause, context: { errors } },
      )
    }

    if (!result.success) {
      const messages = result.logs.map((l) => l.message ?? String(l)).join('\n')
      throw new TemplateError(
        `buildIslands failed:\n${messages.length > 0 ? messages : '(no diagnostic — try running without --minify)'}`,
        { context: { logs: result.logs.map((l) => l.message) } },
      )
    }

    return {
      output: join(outputDir, filename),
      islands: islands.map((i) => i.name),
      setups: setupFiles,
    }
  } finally {
    await rm(entryDir, { recursive: true, force: true })
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Bun.build throws an Error whose `.message` is the generic
 * `"Bundle failed"`. The actual messages are attached either as an
 * `errors` array (BuildError) or as the AggregateError-style
 * `.errors`. Pull whichever is present so callers see real output.
 */
function extractBunBuildMessages(cause: unknown): string[] {
  if (cause === null || typeof cause !== 'object') return []
  const c = cause as { errors?: unknown; logs?: unknown }
  const collected: string[] = []
  const list = Array.isArray(c.errors) ? c.errors : Array.isArray(c.logs) ? c.logs : []
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'string') {
      collected.push(entry)
    } else if (typeof entry === 'object' && 'message' in entry) {
      collected.push(String((entry as { message: unknown }).message))
    } else {
      collected.push(String(entry))
    }
  }
  return collected
}


interface DiscoveredInputs {
  vueFiles: string[]
  setupFiles: string[]
}

/**
 * Walk `inputDir`. Collect `.vue` files anywhere; collect setup files
 * ONLY at the root level (`<inputDir>/setup*.{ts,js,mts,mjs}`). The
 * root constraint mirrors 0.x and keeps the discovery rule simple —
 * apps that need conditional setup put logic inside `setup.ts`, not
 * across many sibling files in subdirectories.
 */
async function discoverInputs(inputDir: string): Promise<DiscoveredInputs> {
  const vueFiles: string[] = []
  const setupFiles: string[] = []

  // Root-level pass for setup files.
  let rootEntries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
  try {
    rootEntries = await readdir(inputDir, { withFileTypes: true })
  } catch {
    return { vueFiles: [], setupFiles: [] }
  }
  for (const e of rootEntries) {
    if (e.isFile() && SETUP_FILENAME_RE.test(e.name)) {
      setupFiles.push(join(inputDir, e.name))
    }
  }
  setupFiles.sort()

  // Recursive pass for .vue files (including the root).
  async function walk(dir: string): Promise<void> {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile() && e.name.endsWith('.vue')) {
        vueFiles.push(full)
      }
    }
  }
  await walk(inputDir)
  vueFiles.sort()

  return { vueFiles, setupFiles }
}

/**
 * `resources/ts/islands/LeadKanban.vue` → island name `LeadKanban`.
 * Nested: `resources/ts/islands/charts/Bar.vue` → `charts.Bar`.
 * The `@island('charts.Bar', {...})` directive then references the
 * nested island; the bundle's lookup table maps the dotted name to
 * the imported component.
 */
function islandNameFor(root: string, file: string): string {
  const rel = relative(root, file)
  const { dir, name } = parsePath(rel)
  if (dir === '') return name
  return `${dir.split(sep).join('.')}.${name}`
}

/**
 * Synthesize the virtual entry module. Imports every island's `.vue`
 * + every `setup.*` file, then builds ONE Vue app whose `Root`
 * component renders a `<Teleport>` for each `[data-island]` element
 * found in the DOM.
 *
 * Apps' `setup.ts` exports a `(app: App) => void` default function.
 * Multiple setup files run in alphabetical order on the same app —
 * `setup.ts` registers Pinia, `setup.router.ts` registers the
 * router, etc.
 */
function generateEntry(
  islands: Array<{ name: string; path: string }>,
  setupFiles: string[],
): string {
  const lines: string[] = [
    `// AUTOGENERATED by @strav/view buildIslands(). Do not edit by hand.`,
    `import { createApp, defineComponent, h, Teleport } from 'vue'`,
    ``,
  ]

  for (let i = 0; i < setupFiles.length; i += 1) {
    lines.push(`import __setup_${i} from ${JSON.stringify(setupFiles[i])}`)
  }
  if (setupFiles.length > 0) lines.push('')

  for (let i = 0; i < islands.length; i += 1) {
    lines.push(`import __c${i} from ${JSON.stringify(islands[i]?.path ?? '')}`)
  }
  lines.push('')

  lines.push(`const __setups = [${setupFiles.map((_, i) => `__setup_${i}`).join(', ')}]`)
  lines.push('const __components = {')
  for (let i = 0; i < islands.length; i += 1) {
    lines.push(`  ${JSON.stringify(islands[i]?.name ?? '')}: __c${i},`)
  }
  lines.push('}')
  lines.push('')

  lines.push(`function mount() {
  const targets = []
  for (const el of document.querySelectorAll('[data-island]')) {
    const name = el.getAttribute('data-island')
    if (name === null) continue
    const Component = __components[name]
    if (Component === undefined) {
      console.warn('[strav-view] unknown island:', name)
      continue
    }
    let props = {}
    const raw = el.getAttribute('data-props')
    if (raw !== null) {
      try { props = JSON.parse(raw) } catch { props = {} }
    }
    targets.push({ Component, props, el })
  }
  if (targets.length === 0) return

  const Root = defineComponent({
    render() {
      return targets.map((t) => h(Teleport, { to: t.el }, [h(t.Component, t.props)]))
    },
  })
  const app = createApp(Root)
  for (const setup of __setups) {
    if (typeof setup === 'function') setup(app)
  }
  // Mount onto a hidden root — the Teleports do the real placement.
  const root = document.createElement('div')
  root.style.display = 'contents'
  document.body.appendChild(root)
  app.mount(root)
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
}
`)

  return lines.join('\n')
}
