/**
 * `CacheConsoleProvider` — declares the `cache:*` commands.
 *
 * Apps add it to `bootstrap/providers.ts` alongside the cache
 * provider (`CacheProvider` for in-memory, `RedisCacheProvider`,
 * `PostgresCacheProvider`, or `MemcachedCacheProvider`). Separate
 * provider so apps that don't ship a CLI don't pay the cost of
 * resolving commands at boot — same pattern as
 * `QueueConsoleProvider` and `RagConsoleProvider`.
 */

import { ConsoleProvider } from '@strav/cli'
import { CacheClear } from './cache_clear.ts'
import { CacheForget } from './cache_forget.ts'
import { CacheList } from './cache_list.ts'

export class CacheConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.cache'
  override readonly commands = [CacheClear, CacheForget, CacheList] as const
}
