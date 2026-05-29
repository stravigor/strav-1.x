/**
 * `bun strav config:list` — list every top-level config namespace.
 *
 * Useful for sanity-checking what `ConfigProvider` actually loaded —
 * e.g., confirming that `config.auth` is present after wiring a new
 * provider, or seeing which app sections are populated in production
 * vs. development.
 *
 * Pairs with `config:show <key>` for drilling in. Outputs one
 * namespace per line, alphabetically sorted, with a trailing `(empty)`
 * marker for namespaces whose value is `undefined` / `null` / an empty
 * object.
 */

import { ConfigRepository } from '@strav/kernel'
import { Command } from './command.ts'
import { ExitCode } from './exit_codes.ts'

export class ConfigList extends Command {
  static signature = 'config:list'
  static description = 'List top-level config namespaces (app, auth, database, …).'
  static providers = ['config']

  override execute(): number {
    const all = this.app.resolve(ConfigRepository).all()
    const keys = Object.keys(all).sort()

    if (keys.length === 0) {
      this.info('No config namespaces are loaded.')
      return ExitCode.Success
    }

    for (const key of keys) {
      const value = all[key]
      const empty =
        value == null ||
        (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
      this.line(empty ? `${key} (empty)` : key)
    }
    return ExitCode.Success
  }
}
