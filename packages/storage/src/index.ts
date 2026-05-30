// Public API of @strav/storage.
//
// Root barrel exports the primitive — `Storage` base class + types +
// errors + the LocalStorage provider. Drivers ship under subpaths:
//   - `@strav/storage/local`  (re-exports for explicit construction)
//   - `@strav/storage/s3`     (S3-compatible: AWS / R2 / B2 / Tigris / MinIO)

export { LocalStorage, type LocalStorageOptions } from './drivers/local/local_storage.ts'
export { normalizePath, normalizePrefix } from './path.ts'
export { Storage } from './storage.ts'
export {
  StorageConfigError,
  StorageDriverError,
  StorageError,
  StorageNotFoundError,
  StoragePathError,
} from './storage_error.ts'
export { type LocalStorageConfig, StorageProvider } from './storage_provider.ts'
export type {
  ListEntry,
  ListOptions,
  ListResult,
  PutOptions,
  SignedUrlOptions,
  StorageStat,
  StorageWriteable,
} from './types.ts'
