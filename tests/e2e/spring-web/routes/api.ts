import type { Router } from '@strav/http'

/**
 * Wire JSON routes. Imported and called from `app/providers/app_provider.ts`.
 *
 * The router is a registry until boot, so this function only declares routes;
 * the actual trie compile happens inside `HttpProvider.boot()`.
 */
export function registerApiRoutes(router: Router): void {
  router.get('/healthz', () => Response.json({ ok: true }))
}
