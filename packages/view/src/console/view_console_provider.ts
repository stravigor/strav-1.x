/**
 * `ViewConsoleProvider` — declares view console commands.
 *
 * Apps add it to `bootstrap/providers.ts` alongside `ViewProvider`.
 * The provider must come AFTER `ViewProvider` in the default list so
 * `view:cache` / `view:clear` can resolve `ViewEngine` from the
 * container (or pass `static providers = ['config', 'logger', 'view']`
 * to boot the minimum subset).
 */

import { ConsoleProvider } from '@strav/cli'
import { ViewBuild } from './view_build.ts'
import { ViewCache } from './view_cache.ts'
import { ViewClear } from './view_clear.ts'

export class ViewConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.view'
  override readonly commands = [ViewCache, ViewClear, ViewBuild] as const
}
