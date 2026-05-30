// Public API of @strav/cache.
//
// Root barrel exports the primitive — `Cache` base class + types +
// errors + the in-memory provider. Drivers ship under subpaths:
//   - `@strav/cache/memory`   (re-exports for explicit construction)
//   - `@strav/cache/postgres` (Postgres cross-process backplane)

export { Cache } from './cache.ts'
export {
  CacheConfigError,
  CacheDriverError,
  CacheError,
  CacheLockTimeoutError,
  CacheTtlParseError,
} from './cache_error.ts'
export { CacheProvider, type MemoryCacheConfig } from './cache_provider.ts'
export { MemoryCache, type MemoryCacheOptions } from './drivers/memory/memory_cache.ts'
export { parseTtl, ttlToExpiresAt } from './ttl.ts'
export type { CacheLock, CacheTtl, TaggedCache } from './types.ts'
