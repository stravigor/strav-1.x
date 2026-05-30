/**
 * `bun strav cache:clear [--force]` — flush every key from the
 * active cache store.
 *
 * Mirrors `Cache.flush()` directly. Confirms before running unless
 * `--force` is set (CI / scripted teardown). Driver-specific
 * notes:
 *
 *   - `MemoryCache` — clears the in-process map; only affects this
 *     process.
 *   - `RedisCache` — `SCAN` + `DEL` under the configured `prefix`
 *     so other apps sharing the Redis DB are untouched.
 *   - `PostgresCache` — `TRUNCATE` of the cache ledger table.
 *   - `MemcachedCache` — `FLUSH_ALL` (server-wide).
 *
 * Use scoped invalidation (`cache.tags(...).flush()`,
 * `cache.forget(key)`) in production code paths; `cache:clear` is
 * the deploy-time / dev tool.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { Cache } from '../cache.ts'

export class CacheClear extends Command {
  static signature = 'cache:clear {--force}'
  static description = 'Flush every entry from the active cache store.'
  static providers = ['config', 'logger', 'cache']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    if (flags.force !== true) {
      const ok = await this.confirm(
        'Flush every entry from the active cache store? This is irreversible.',
      )
      if (!ok) {
        this.info('Aborted.')
        return ExitCode.Success
      }
    }
    const cache = this.app.resolve(Cache)
    await cache.flush()
    this.success('Cache flushed.')
    return ExitCode.Success
  }
}
