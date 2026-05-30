/**
 * `bun strav cache:list` — print the active cache driver + key
 * config knobs.
 *
 * Diagnostic only. Useful for verifying that `config/cache.ts`
 * parses cleanly and that the deployed binary picked up the
 * intended driver (Redis vs in-memory in CI, etc.). No mutations.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { ConfigRepository } from '@strav/kernel'

export class CacheList extends Command {
  static signature = 'cache:list'
  static description = 'Show the active cache driver and its configuration.'
  static providers = ['config', 'logger', 'cache']

  override async execute(_args: ExecuteArgs): Promise<number> {
    const cfg = this.app.resolve(ConfigRepository).get('cache') as
      | (Record<string, unknown> & { driver?: string })
      | undefined

    if (cfg === undefined) {
      this.info('No `config.cache` entry. The cache provider booted with defaults.')
      return ExitCode.Success
    }

    const driver = cfg.driver ?? '(unset)'
    this.info(`Driver: ${driver}`)
    for (const [key, value] of Object.entries(cfg)) {
      if (key === 'driver') continue
      const printed =
        typeof value === 'string' && key.toLowerCase().includes('password')
          ? '***'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)
      this.info(`  ${key}: ${printed}`)
    }
    return ExitCode.Success
  }
}
