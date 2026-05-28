/**
 * `bun strav route:list` — table of all registered routes.
 *
 * Columns: Method, Path, Name (if set), Middleware.
 * Output is sorted: static routes first (alphabetical by path), then
 * parameterised routes, then catch-all/wildcard routes.
 */

import { Command, ExitCode } from '@strav/cli'
import { Router } from '../router/router.ts'

export class RouteList extends Command {
  static signature = 'route:list'
  static description = 'List all registered HTTP routes.'
  static providers = ['config', 'logger', 'http']

  override execute(): number {
    const router = this.app.resolve(Router)
    const routes = router.list()

    if (routes.length === 0) {
      this.info('No routes registered.')
      return ExitCode.Success
    }

    const sorted = [...routes].sort((a, b) => {
      const aScore = score(a.pattern)
      const bScore = score(b.pattern)
      if (aScore !== bScore) return aScore - bScore
      return a.pattern.localeCompare(b.pattern)
    })

    this.table(
      ['Method', 'Path', 'Name', 'Middleware'],
      sorted.map((r) => [
        r.method,
        r.pattern,
        r.name ?? '-',
        r.middleware.length > 0 ? r.middleware.join(', ') : '-',
      ]),
    )
    return ExitCode.Success
  }
}

/**
 * Ordering score: static < parameterised < wildcard.
 * Lower score = shown first.
 */
function score(pattern: string): number {
  if (pattern.includes('*')) return 2
  if (pattern.includes(':')) return 1
  return 0
}
