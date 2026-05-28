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
import {
  type CompilationResult,
  compile,
  type RenderContext,
  type RenderResult,
} from './compiler.ts'
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

  constructor(opts: ViewEngineOptions) {
    const dir = opts.config.directory ?? 'resources/views'
    this.directory = isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
    this.cacheEnabled = opts.config.cache ?? true
    this.globals = opts.config.globals ?? {}
    this.read = opts.read ?? ((path) => readFile(path, 'utf8'))
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
    const tokens = tokenize(source)
    const compiled = compile(tokens)
    if (this.cacheEnabled) this.cache.set(name, compiled)
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
      yieldSection(name) {
        return sections[name] ?? ''
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
      asset(path) {
        // Real asset versioning lands with the bundler in the next
        // view slice. Pass-through for now.
        return String(path)
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
