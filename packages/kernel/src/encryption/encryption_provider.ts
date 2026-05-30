/**
 * `EncryptionProvider` reads `config('encryption')`, parses the key, and
 * binds `Cipher` (singleton) to an `AesGcm256Cipher`.
 *
 * Depends on `'config'`, so `ConfigProvider` must be registered first.
 * Boots eagerly — config-shaped errors (missing key, wrong length, bad
 * encoding) surface at `app.start()` rather than on the first encrypted
 * write inside a request.
 *
 * Apps that don't store anything encrypted simply omit this provider.
 * The unbound `Cipher` resolves to the base no-op class, which throws
 * a `ConfigError` if anything ever tries to encrypt/decrypt — surfacing
 * the misconfiguration loudly the first time it's actually used.
 *
 * @see docs/kernel/guides/encryption.md
 */

import { ConfigRepository } from '../config/configuration.ts'
import { type Application, ServiceProvider } from '../core/index.ts'
import { ConfigError } from '../exceptions/config_error.ts'
import { AesGcm256Cipher, Cipher, parseEncryptionKey } from './cipher.ts'

/**
 * The shape `config.encryption` must take. The provider tolerates either
 * a Uint8Array (precise) or a string (hex / base64) — the latter is what
 * apps typically write into `config/encryption.ts`, sourced from an env
 * var.
 */
export interface EncryptionConfig {
  /** 32-byte key; hex (64 chars) or base64 (44 chars padded) or Uint8Array. */
  key: string | Uint8Array
  /**
   * Optional ring of previous keys. Encryption always uses `key`;
   * decryption falls through `key` → `previousKeys[0]` → `previousKeys[1]`
   * → ... until one verifies. Use during rotation: keep the old key
   * here for as long as legacy ciphertext (or blind-index columns
   * computed under the old key) still lives in the database.
   */
  previousKeys?: ReadonlyArray<string | Uint8Array>
}

export class EncryptionProvider extends ServiceProvider {
  override readonly name = 'encryption'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(Cipher, (c) => {
      const raw = c.resolve(ConfigRepository).get('encryption')
      if (raw === undefined || raw === null) {
        throw new ConfigError(
          'EncryptionProvider: `config.encryption` is missing. ' +
            'Add a `config/encryption.ts` file that exports `{ key: env.required("ENCRYPTION_KEY") }`.',
          { code: 'encryption.config-missing' },
        )
      }
      const cfg = raw as EncryptionConfig
      const key = parseEncryptionKey(cfg.key)
      const previousKeys = (cfg.previousKeys ?? []).map((k) => parseEncryptionKey(k))
      return new AesGcm256Cipher({ key, previousKeys })
    })
  }

  override async boot(app: Application): Promise<void> {
    // Construct the cipher now so config-shape errors surface at boot.
    app.resolve(Cipher)
  }
}
