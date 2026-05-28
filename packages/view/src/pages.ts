/**
 * Pages auto-router — walks `<pagesDir>/**\/*.strav` and registers one
 * GET route per file onto the provided `Router`.
 *
 * File → URL mapping:
 *   pages/index.strav               → GET /
 *   pages/about.strav               → GET /about
 *   pages/blog/index.strav          → GET /blog
 *   pages/blog/[slug].strav         → GET /blog/:slug
 *   pages/docs/[...path].strav      → GET /docs/*
 *   pages/_partials/cta.strav       → (skipped — leading underscore)
 *
 * Routes are registered BEFORE the router is compiled. Call this inside
 * `ViewProvider.boot()` or before any call to `router.compile()`.
 *
 * The generated handler renders the template with:
 *   - `params`  — captured URL segments (from ctx.request.params)
 *   - `query`   — URL query string (from ctx.request.query)
 *
 * `middleware` is applied to every auto-routed page; pass an empty array
 * to have none (default).
 *
 * Pages have NO data loader. If a page needs DB data, use an explicit
 * controller-based route. The clean line between page and controller is
 * what keeps this feature small.
 */

import { sep } from 'node:path'
import type { HttpContext, Router } from '@strav/http'
import type { ViewEngine } from './view_engine.ts'

export interface PagesOptions {
  /**
   * Absolute path of the pages directory.
   * Default: `<viewEngine.viewDirectory>/pages`
   */
  pagesDir?: string
  /** Middleware applied to every auto-routed page. */
  middleware?: readonly string[]
}

export interface DiscoveredPage {
  /** Dotted template name (as passed to `ViewEngine.render`). */
  templateName: string
  /** URL pattern (e.g. `/blog/:slug`, `/`). */
  urlPattern: string
}

/**
 * Walk `pagesDir` for `*.strav` files and register GET routes on `router`.
 * Returns the list of pages that were registered (for introspection / tests).
 *
 * Skips any file or directory segment that starts with `_`.
 */
export async function registerPages(
  engine: ViewEngine,
  router: Router,
  options: PagesOptions = {},
): Promise<DiscoveredPage[]> {
  const pagesDir = options.pagesDir ?? `${engine.viewDirectory}${sep}pages`
  const middleware = options.middleware ?? []

  const glob = new Bun.Glob('**/*.strav')
  const registered: DiscoveredPage[] = []

  const files: string[] = []
  try {
    for await (const rel of glob.scan({ cwd: pagesDir, absolute: false })) {
      files.push(rel)
    }
  } catch {
    // Pages directory doesn't exist — nothing to register.
    return []
  }

  // Sort so static routes come before dynamic ones (Router.compile()
  // handles precedence via the trie, but deterministic insertion order
  // makes tests easier to reason about).
  files.sort()

  for (const rel of files) {
    // Skip any segment starting with underscore.
    const segments = rel.split(/[/\\]/)
    if (segments.some((s) => s.startsWith('_'))) continue

    const page = fileToPage(rel)
    if (!page) continue

    const { templateName, urlPattern } = page
    const capturedTemplateName = templateName
    const handler = async (ctx: HttpContext): Promise<Response> => {
      const params: Record<string, string> = ctx.request.params
      const query: Record<string, string | string[]> = ctx.request.query
      const html = await engine.render(capturedTemplateName, { params, query })
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    const route = router.get(urlPattern, handler)
    if (middleware.length > 0) {
      route.middleware(...middleware)
    }

    registered.push({ templateName, urlPattern })
  }

  return registered
}

/**
 * Convert a relative `.strav` file path (using OS separator) into a
 * `DiscoveredPage`. Returns `null` for paths that shouldn't be routed.
 *
 * Examples:
 *   index.strav               → { template: 'pages.index',    url: '/' }
 *   about.strav               → { template: 'pages.about',    url: '/about' }
 *   blog/index.strav          → { template: 'pages.blog.index', url: '/blog' }
 *   blog/[slug].strav         → { template: 'pages.blog.[slug]', url: '/blog/:slug' }
 *   docs/[...path].strav      → { template: 'pages.docs.[...path]', url: '/docs/*' }
 */
export function fileToPage(rel: string): DiscoveredPage | null {
  // Normalise to forward slashes.
  const normalised = rel.replace(/\\/g, '/')
  // Remove the .strav extension.
  const withoutExt = normalised.replace(/\.strav$/, '')

  const parts = withoutExt.split('/')

  // Build URL pattern segments.
  const urlParts: string[] = []
  for (const part of parts) {
    if (part.startsWith('_')) return null
    if (part === 'index') {
      // index.strav at the root or in a folder collapses to nothing.
      // The folder itself is already in urlParts; just skip the segment.
      continue
    }
    if (part.startsWith('[...') && part.endsWith(']')) {
      // Wildcard: [...path] → *
      urlParts.push('*')
    } else if (part.startsWith('[') && part.endsWith(']')) {
      // Dynamic: [slug] → :slug
      const paramName = part.slice(1, -1)
      urlParts.push(`:${paramName}`)
    } else {
      urlParts.push(part)
    }
  }

  const urlPattern = urlParts.length === 0 ? '/' : `/${urlParts.join('/')}`

  // Build dotted template name including the `pages.` prefix.
  const templateName = `pages.${withoutExt.replace(/\//g, '.')}`

  return { templateName, urlPattern }
}
