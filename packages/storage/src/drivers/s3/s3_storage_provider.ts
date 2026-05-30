/**
 * `S3StorageProvider` — wires `S3Storage` under the `Storage` token.
 * Apps register this INSTEAD OF `StorageProvider` to use an
 * S3-compatible backplane (AWS / R2 / B2 / Tigris / MinIO).
 */

import { type Application, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { Storage } from '../../storage.ts'
import { StorageConfigError } from '../../storage_error.ts'
import { S3Storage, type S3StorageOptions } from './s3_storage.ts'

export interface S3StorageConfig extends Omit<S3StorageOptions, 'client'> {
  driver: 's3'
}

export class S3StorageProvider extends ServiceProvider {
  override readonly name = 'storage'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Storage, (c) => {
      const cfg = c.resolve(ConfigRepository).get('storage') as S3StorageConfig | undefined
      if (cfg === undefined || cfg.driver !== 's3') {
        throw new StorageConfigError(
          'S3StorageProvider: `config.storage` must have `driver: "s3"`.',
        )
      }
      if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
        throw new StorageConfigError(
          'S3StorageProvider: `accessKeyId`, `secretAccessKey`, and `bucket` are required.',
        )
      }
      return new S3Storage({
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        bucket: cfg.bucket,
        ...(cfg.region !== undefined ? { region: cfg.region } : {}),
        ...(cfg.endpoint !== undefined ? { endpoint: cfg.endpoint } : {}),
        ...(cfg.sessionToken !== undefined ? { sessionToken: cfg.sessionToken } : {}),
        ...(cfg.virtualHostedStyle !== undefined
          ? { virtualHostedStyle: cfg.virtualHostedStyle }
          : {}),
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
