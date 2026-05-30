/**
 * `StorageProvider` — wires `LocalStorage` under the `Storage` token
 * by default.
 *
 * Apps that want the S3 backplane swap providers:
 *
 *   import { StorageProvider } from '@strav/storage'
 *   import { S3StorageProvider } from '@strav/storage/s3'
 *
 *   providers: [
 *     ...,
 *     new S3StorageProvider(),    // instead of StorageProvider
 *   ]
 *
 * Both providers register under the same `Storage` token, so app code
 * injecting `Storage` doesn't change between dev and prod.
 *
 * Eager singleton — config errors surface at boot rather than on the
 * first `storage.put()` call.
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { LocalStorage, type LocalStorageOptions } from './drivers/local/local_storage.ts'
import { Storage } from './storage.ts'
import { StorageConfigError } from './storage_error.ts'

export interface LocalStorageConfig extends LocalStorageOptions {
  driver: 'local'
}

export class StorageProvider extends ServiceProvider {
  override readonly name = 'storage'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Storage, (c) => {
      const cfg = c.resolve(ConfigRepository).get('storage') as LocalStorageConfig | undefined
      if (cfg === undefined || cfg.driver !== 'local' || !cfg.root) {
        throw new StorageConfigError(
          'StorageProvider: `config.storage.root` is required (set `config/storage.ts` with `{ driver: "local", root: "storage/uploads" }`).',
        )
      }
      return new LocalStorage({
        root: cfg.root,
        ...(cfg.publicBase !== undefined ? { publicBase: cfg.publicBase } : {}),
      })
    })
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(Storage)
  }

  override async shutdown(app: Application): Promise<void> {
    await app.resolve(Storage).close()
  }
}
