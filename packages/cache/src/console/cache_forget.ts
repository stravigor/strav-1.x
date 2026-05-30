/**
 * `bun strav cache:forget <key>` — drop one cache entry.
 *
 * Exit code 0 when a key was removed; 0 with a warning when nothing
 * matched (no key to forget is not an error — apps script this from
 * deploy hooks where the entry may or may not be live).
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { Cache } from '../cache.ts'

export class CacheForget extends Command {
  static signature = 'cache:forget {key}'
  static description = 'Delete a single cache entry by key.'
  static providers = ['config', 'logger', 'cache']

  override async execute({ args }: ExecuteArgs): Promise<number> {
    const key = args.key as string
    const cache = this.app.resolve(Cache)
    const removed = await cache.forget(key)
    if (removed) {
      this.success(`Forgot "${key}".`)
    } else {
      this.warn(`No entry for "${key}".`)
    }
    return ExitCode.Success
  }
}
