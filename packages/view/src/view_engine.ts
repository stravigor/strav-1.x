/**
 * `ViewEngine` — public surface of `@strav/view`.
 *
 * Resolved from the container (`MailProvider`-style binding). Apps call:
 *
 *   const html = await view.render('pages.dashboard', { user, leads })
 *
 * Resolution:
 *   - `'pages.dashboard'` → `{viewRoot}/pages/dashboard.strav`.
 *   - The root is `config.view.directory` (default `resources/views`),
 *     made absolute against `process.cwd()` if relative.
 *
 * Compilation:
 *   - Source is tokenised + compiled to a render function on first
 *     use, then cached in-memory by template name.
 *   - In dev mode (`config.view.cache === false`), the cache is
 *     bypassed — every render recompiles. Useful with `bun --hot`.
 *
 * Layouts:
 *   - `@extends('layouts.app')` declares a parent template.
 *   - The child renders first into a section / stack pool, then the
 *     parent renders with that pool available to `@yield` / `@stack`.
 *
 * Includes:
 *   - Runtime resolution — `@include('partials.alert', { kind })`
 *     fetches + renders the included template, returning its HTML to
 *     the parent's output stream. A 50-deep stack guard prevents
 *     infinite recursion.
 *
 * Globals:
 *   - Helpers like `auth`, `config`, `route`, `asset`, `t` are
 *     stubbed in slice 1 — they return safe defaults so templates
 *     compile and render, with real implementations wiring in
 *     once the relevant subsystems land.
 *
 * What slice 1 does NOT do:
 *   - No disk cache (`storage/cache/views`).
 *   - No `view:cache` / `view:build` commands (wait on `@strav/cli`).
 *   - No `@island` (compile-time error today).
 *   - No pages auto-routing (lands as a separate slice).
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { AssetManifest, type AssetManifestOptions } from './asset_manifest.ts'
import {
  type CompilationResult,
  compile,
  type RenderContext,
  type RenderResult,
} from './compiler.ts'
import { DiskCache } from './disk_cache.ts'
import { escapeHtml } from './escape.ts'
import { TemplateError } from './template_error.ts'
import { tokenize } from './tokenizer.ts'

const MAX_INCLUDE_DEPTH = 50

export interface ViewConfig {
  /** Root directory containing `.strav` files. Defaults to `resources/views`. */
  directory?: string
  /**
   * Compile cache. Default `true` in production-style usage. Set to
   * `false` in dev to recompile on every render (useful with hot
   * reload).
   */
  cache?: boolean
  /** Optional global locals added to every render's data. */
  globals?: Record<string, unknown>
  /**
   * Directory containing `*.vue` island components. Used by `view:build`.
   * Defaults to `resources/islands`. Mutually exclusive with
   * `islandSources` — when both are set, `islandSources` wins.
   */
  islandsDir?: string
  /**
   * Multiple island source directories merged into one bundle. Use
   * this when the app is organised by module (e.g. one
   * `resources/ts/islands/` for the host + one per `app/modules/*`
   * package). Each source contributes `.vue` files; namespaced
   * sources prefix component names (`@island('auth.LoginForm')`).
   *
   * At most one source may omit `namespace` — that's the host app's
   * anonymous root.
   */
  islandSources?: ReadonlyArray<{ inputDir: string; namespace?: string }>
  /**
   * Output directory for the compiled `islands.js` bundle. Used by `view:build`.
   * Defaults to `public/assets/islands`.
   */
  islandsOut?: string
  /**
   * Disk cache for compiled templates. `true` (default) enables it
   * with the default directory (`storage/cache/views`). `false` opts
   * out entirely. An object overrides the directory.
   */
  diskCache?: boolean | { directory?: string }
  /**
   * Asset versioning. Omit to use defaults (publicDir `public`,
   * manifest at `public/manifest.json`, prefix `/`). Pass `false` to
   * keep `@asset(path)` as a pure pass-through (no fingerprint, no
   * mtime query string).
   */
  assets?: false | AssetManifestOptions
  /**
   * Stylesheet bundling for `view:build`. Each entry is bundled via
   * `Bun.build` and emitted under `outputDir` with its original
   * basename. Default outputDir matches the spring `--web` template
   * layout (`public/assets`). Empty `inputs` skips the CSS pass.
   */
  css?: {
    /**
     * CSS entries. Three shapes:
     *
     *   - `string[]`              — auto-named from basename.
     *   - `Record<string,string>` — explicit name keys (multi-bundle
     *     apps with separate `app` / `admin` / `vendor` sheets).
     *   - omitted                 — uses `linkPath` only (single sheet).
     *
     * `@css` emits links for ALL entries (in order). `@css('name')`
     * emits the named one. Order matters — the cascade respects it.
     */
    inputs?: readonly string[] | Record<string, string>
    /** Where bundled CSS lands. Default: `public/assets`. */
    outputDir?: string
    /**
     * Single-entry shorthand. When `inputs` isn't set, `@css` emits
     * `<link>` pointing at this path (resolved through the asset
     * manifest for versioning). Default: `'app.css'`. Set to `null`
     * or `''` to make `@css` emit nothing.
     *
     * Ignored when `inputs` is set — the multi-entry map wins.
     */
    linkPath?: string | null
  }
  /**
   * Auto-paths emitted by `@islands` (script tag) — resolved through
   * the asset manifest for fingerprinting / mtime-versioning.
   */
  islands?: {
    /**
     * Path used by `@islands`. Default: `'islands/islands.js'`
     * (matches `config.view.islandsOut` of `public/assets/islands`).
     */
    scriptPath?: string | null
  }
  /**
   * Pages auto-router options. Omit to use defaults (autoRoute: true,
   * pagesDir: `<directory>/pages`, no extra middleware).
   */
  pages?: {
    /**
     * Enable file-based routing for `.strav` files under `<directory>/pages/`.
     * Default `true`. Set to `false` to opt out entirely.
     */
    autoRoute?: boolean
    /**
     * Middleware names applied to EVERY auto-routed page. Empty by default.
     */
    middleware?: readonly string[]
    /**
     * Override the pages directory (absolute or relative to CWD).
     * Default: `<config.directory>/pages`.
     */
    pagesDir?: string
  }
}

export interface ViewEngineOptions {
  config: ViewConfig
  /** Reads file contents — injected so tests can pass in-memory fixtures. */
  read?: (absolutePath: string) => Promise<string>
}

export class ViewEngine {
  private readonly directory: string
  private readonly cacheEnabled: boolean
  private readonly globals: Record<string, unknown>
  private readonly read: (path: string) => Promise<string>
  private readonly cache = new Map<string, CompilationResult>()
  private readonly diskCache: DiskCache | undefined
  private readonly assets: AssetManifest | undefined
  private readonly islandsScriptPath: string | null
  /**
   * Ordered list of `(name, path)` pairs used by `@css` / `@css(name)`.
   * Empty when the app neither set `css.inputs` nor `css.linkPath`
   * (or set both to null) — `@css` emits nothing in that case.
   */
  private readonly cssEntries: ReadonlyArray<{ name: string; path: string }>

  constructor(opts: ViewEngineOptions) {
    const dir = opts.config.directory ?? 'resources/views'
    this.directory = isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
    this.cacheEnabled = opts.config.cache ?? true
    this.globals = opts.config.globals ?? {}
    this.read = opts.read ?? ((path) => readFile(path, 'utf8'))

    if (this.cacheEnabled && opts.config.diskCache !== false) {
      const diskOpt = opts.config.diskCache
      const diskDir =
        typeof diskOpt === 'object' && diskOpt !== null && diskOpt.directory !== undefined
          ? diskOpt.directory
          : 'storage/cache/views'
      this.diskCache = new DiskCache(
        isAbsolute(diskDir) ? diskDir : resolve(process.cwd(), diskDir),
      )
    }

    if (opts.config.assets !== false) {
      this.assets = new AssetManifest(opts.config.assets ?? {})
    }

    this.islandsScriptPath =
      opts.config.islands?.scriptPath === undefined
        ? 'islands/islands.js'
        : (opts.config.islands.scriptPath || null)

    this.cssEntries = resolveCssEntries(opts.config.css)
  }

  /** The root directory this engine reads `.strav` files from. */
  get viewDirectory(): string {
    return this.directory
  }

  /**
   * Clear the in-memory compilation cache. The next `render()` call
   * for each template will re-read + re-compile from disk. Useful for
   * `view:clear` and during `bun --hot` sessions.
   *
   * The disk cache is NOT touched by this — call `clearDiskCache()`
   * for that. Apps that want a hard reset call both.
   */
  clearCache(): void {
    this.cache.clear()
    this.assets?.reload()
  }

  /**
   * Remove every persisted compilation under the configured disk
   * cache directory. The next compile re-emits + re-writes entries.
   * No-op when disk caching is disabled.
   */
  async clearDiskCache(): Promise<void> {
    if (this.diskCache === undefined) return
    await this.diskCache.clear()
  }

  /** The on-disk cache directory, if disk caching is enabled. */
  get diskCacheDirectory(): string | undefined {
    return this.diskCache?.directory
  }

  /**
   * Walk `directory` for every `*.strav` file and compile + cache each
   * one. Returns the names of templates that were pre-compiled.
   *
   * Used by `view:cache` to warm the engine ahead of the first request.
   * Files that fail to compile are reported but don't abort the pass —
   * the caller surfaces the errors.
   */
  async warmCache(): Promise<{
    warmed: string[]
    errors: Array<{ name: string; error: unknown }>
  }> {
    const warmed: string[] = []
    const errors: Array<{ name: string; error: unknown }> = []
    const glob = new Bun.Glob('**/*.strav')
    for await (const rel of glob.scan({ cwd: this.directory, absolute: false })) {
      // Convert file-system relative path → dotted template name:
      //   layouts/app.strav → layouts.app
      const name = rel.replace(/[/\\]/g, '.').replace(/\.strav$/, '')
      try {
        await this.compileTemplate(name)
        warmed.push(name)
      } catch (err) {
        errors.push({ name, error: err })
      }
    }
    return { warmed, errors }
  }

  /**
   * Render `name` with `data`. Returns the final HTML string. If the
   * template `@extends` a layout, the chain is walked: child first,
   * then parent with the child's sections + stacks merged in.
   */
  async render(name: string, data: Record<string, unknown> = {}): Promise<string> {
    const merged = { ...this.globals, ...data }
    const sections: Record<string, string> = {}
    const stacks: Record<string, string[]> = {}
    return this.renderChain(name, merged, sections, stacks, 0)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async renderChain(
    name: string,
    data: Record<string, unknown>,
    sections: Record<string, string>,
    stacks: Record<string, string[]>,
    depth: number,
  ): Promise<string> {
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new TemplateError(
        `Template render depth exceeded (${MAX_INCLUDE_DEPTH}) — likely circular @extends / @include.`,
      )
    }
    const compiled = await this.compileTemplate(name)
    const ctx = this.buildContext(sections, stacks, depth)
    const result = await this.invoke(name, compiled, data, ctx)

    if (compiled.layout === undefined) {
      return result.html
    }
    // Child wrote into `sections` / `stacks`; rendering the layout
    // reads from the same pool via @yield / @stack. The child's own
    // HTML is discarded — only the slot bodies matter for layout
    // composition.
    return this.renderChain(compiled.layout, data, sections, stacks, depth + 1)
  }

  private async invoke(
    templateName: string,
    compiled: CompilationResult,
    data: Record<string, unknown>,
    ctx: RenderContext,
  ): Promise<RenderResult> {
    try {
      return await compiled.render(data, ctx)
    } catch (cause) {
      if (cause instanceof TemplateError) throw cause
      throw new TemplateError(
        `Render error in '${templateName}': ${(cause as Error).message ?? String(cause)}`,
        { cause, context: { template: templateName } },
      )
    }
  }

  private async compileTemplate(name: string): Promise<CompilationResult> {
    if (this.cacheEnabled) {
      const cached = this.cache.get(name)
      if (cached !== undefined) return cached
    }
    const path = this.resolvePath(name)
    let source: string
    try {
      source = await this.read(path)
    } catch (cause) {
      throw new TemplateError(`Template not found or unreadable: '${name}' (${path}).`, {
        cause,
        context: { template: name, path },
      })
    }
    // Disk cache lookup before tokenize+compile: the hash is over the
    // template source, so it auto-invalidates when the file changes.
    if (this.diskCache !== undefined) {
      const fromDisk = await this.diskCache.read(name, source)
      if (fromDisk !== undefined) {
        if (this.cacheEnabled) this.cache.set(name, fromDisk)
        return fromDisk
      }
    }
    const tokens = tokenize(source)
    const compiled = compile(tokens)
    if (this.cacheEnabled) this.cache.set(name, compiled)
    if (this.diskCache !== undefined) {
      await this.diskCache.write(name, source, compiled)
    }
    return compiled
  }

  private resolvePath(name: string): string {
    if (name.length === 0) throw new TemplateError('Empty template name.')
    const relPath = `${name.split('.').join(sep)}.strav`
    const resolved = resolve(this.directory, relPath)
    // Defence against template-name path traversal: refuse anything
    // that resolves outside the configured views directory. Strav-
    // dotted names always resolve cleanly under the directory; the
    // failure case is slash-bearing or otherwise-malformed input.
    const root = this.directory.endsWith(sep) ? this.directory : this.directory + sep
    if (!resolved.startsWith(root) && resolved !== this.directory) {
      throw new TemplateError(`Template name '${name}' resolves outside the views directory.`, {
        context: { template: name, resolved },
      })
    }
    return resolved
  }

  private buildContext(
    sections: Record<string, string>,
    stacks: Record<string, string[]>,
    depth: number,
  ): RenderContext {
    const self = this
    return {
      escape: escapeHtml,
      async include(includeName, includeData) {
        // Includes carry the SAME section/stack pool through so
        // pushes inside an include feed the page's stacks. Layout
        // chain depth + include depth share the same counter.
        return self.renderChain(
          includeName,
          { ...self.globals, ...includeData },
          sections,
          stacks,
          depth + 1,
        )
      },
      section(name, body) {
        // First writer wins — parent layout's @section is the
        // default; the child overrides. Order: child runs first in
        // `renderChain`, then layout. So we set unconditionally;
        // the child's value wins for the layout's @yield.
        sections[name] = body
      },
      setValue(name, value) {
        sections[name] = escapeHtml(value)
      },
      yieldSection(name, fallback) {
        return sections[name] ?? fallback ?? ''
      },
      push(name, body) {
        if (stacks[name] === undefined) stacks[name] = []
        stacks[name].push(body)
      },
      prepend(name, body) {
        if (stacks[name] === undefined) stacks[name] = []
        stacks[name].unshift(body)
      },
      stackOf(name) {
        return (stacks[name] ?? []).join('')
      },
      csrf() {
        // Real CSRF wiring lives in `@strav/http`; the engine
        // emits a placeholder hidden field. Apps that need a real
        // token override the global helper.
        return '<input type="hidden" name="_token" value="">'
      },
      method(verb) {
        return `<input type="hidden" name="_method" value="${escapeHtml(String(verb).toUpperCase())}">`
      },
      route(name) {
        // Route resolution lives in `@strav/http`'s Router; the
        // stub returns the route name verbatim so templates compile
        // and render in isolation. Apps wire a real `route` global.
        return `/__route(${name})`
      },
      asset: (path) => {
        // When an `AssetManifest` is configured (default), resolve the
        // logical path through the manifest / mtime fallback. Apps
        // that opt out (`config.view.assets: false`) get the original
        // pass-through behaviour.
        const s = String(path)
        return self.assets === undefined ? s : self.assets.version(s)
      },
      islandsScript: () => {
        // `@islands` → `<script type="module" src="<versioned>" defer>`.
        // The path is resolved through the same asset manifest as
        // `@asset(...)` — no extra global, no per-build mutation,
        // versioning piggy-backs on what's already there. Returns
        // empty string when the path is disabled (`scriptPath: null`).
        if (self.islandsScriptPath === null) return ''
        const url =
          self.assets === undefined
            ? self.islandsScriptPath
            : self.assets.version(self.islandsScriptPath)
        return `<script type="module" src="${escapeHtmlAttr(url)}" defer></script>`
      },
      cssLink: (name) => {
        // `@css` → emit `<link>` tags for every configured entry, in
        // order. `@css('name')` → emit only the named entry. Empty
        // when no entries are configured (e.g. `linkPath: null`,
        // backend-only app).
        if (self.cssEntries.length === 0) return ''
        const versioned = (path: string): string =>
          self.assets === undefined ? path : self.assets.version(path)
        if (name === undefined) {
          return self.cssEntries
            .map((e) => `<link rel="stylesheet" href="${escapeHtmlAttr(versioned(e.path))}">`)
            .join('')
        }
        const hit = self.cssEntries.find((e) => e.name === name)
        if (hit === undefined) return ''
        return `<link rel="stylesheet" href="${escapeHtmlAttr(versioned(hit.path))}">`
      },
      async component(componentName, props, slot) {
        return self.renderChain(
          `components.${componentName}`,
          { ...self.globals, ...props, slot },
          sections,
          stacks,
          depth + 1,
        )
      },
      async island(islandName, props) {
        // Emit ONLY the hydration marker. The page's layout is
        // responsible for loading the single bundle via a
        // `<script type="module" src="…/islands.js" defer>` tag —
        // typically alongside other site assets, e.g.
        // `<script type="module" src="@asset('islands/islands.js')" defer></script>`.
        //
        // ONE Vue app inside that bundle renders all islands on the
        // page via `<Teleport>` — every `[data-island]` element is
        // mounted into the same root context, so `setup.ts` hooks
        // (Pinia, router, etc.) apply once and all islands share
        // state through the bundled stores.
        const safeName = escapeHtmlAttr(String(islandName))
        const propsJson = escapeHtmlAttr(JSON.stringify(props ?? {}))
        return `<div data-island="${safeName}" data-props="${propsJson}"></div>`
      },
    }
  }
}

/**
 * Resolve `config.view.css` to an ordered list of `(name, path)` entries.
 *
 *   - `inputs` set (array or record) → use those, in iteration order.
 *     The `name` is the basename for string-array inputs, or the
 *     record key for object inputs.
 *   - `inputs` absent + `linkPath` set → single entry named `'default'`.
 *   - `inputs` absent + `linkPath` undefined → default `app.css` (single).
 *   - `linkPath: null` AND no `inputs` → empty list (no `<link>` emitted).
 */
function resolveCssEntries(
  css: ViewConfig['css'] | undefined,
): ReadonlyArray<{ name: string; path: string }> {
  if (css?.inputs !== undefined) {
    if (Array.isArray(css.inputs)) {
      return css.inputs.map((p) => {
        const last = p.split('/').pop() ?? p
        const name = last.replace(/\.css$/i, '')
        // Convert input source path → output URL path (basename in
        // outputDir → linked as `<name>.css`).
        return { name, path: `${name}.css` }
      })
    }
    return Object.keys(css.inputs).map((name) => ({ name, path: `${name}.css` }))
  }
  if (css?.linkPath === null) return []
  return [{ name: 'default', path: css?.linkPath ?? 'app.css' }]
}

/**
 * Escape for safe embedding inside an HTML double-quoted attribute.
 * Differs from `escapeHtml` only in that ASCII single quotes pass
 * through (they're not significant inside `"..."`). Used for the
 * `data-props` payload — JSON commonly contains `'` characters that
 * we don't want to encode.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
