import type { Router } from '@strav/http'

/**
 * HTML / browser-facing routes that need to be hand-declared (login forms,
 * dynamic redirects, sitemap.xml — anything that can't be a static
 * `.strav` page).
 *
 * Two things you may NOT need to wire here:
 *
 *   1. **Auto-routed pages** — `@strav/view` registers a GET route for
 *      every `.strav` file under `resources/views/pages/` automatically.
 *   2. **Static assets** — set `publicDir: 'public'` in `config/http.ts`
 *      (already wired in the scaffolded config) and the HTTP kernel will
 *      serve files from `public/` for any unrouted GET / HEAD request.
 *      Path traversal is rejected; routed paths still win over disk.
 */
export function registerWebRoutes(_router: Router): void {
  // Hand-declared web routes go here.
}
