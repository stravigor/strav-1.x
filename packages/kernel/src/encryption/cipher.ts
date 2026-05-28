/**
 * Symmetric cipher — encrypts/decrypts UTF-8 strings to/from bytea-safe bytes.
 *
 * The base `Cipher` class is constructable (no args) but throws on every
 * encrypt/decrypt call. That lets the DI container resolve `cipher?: Cipher`
 * for any consumer even when `EncryptionProvider` isn't registered — the
 * throw only fires if a Repository whose Model declares `@encrypt` fields
 * actually tries to use the cipher. Apps without encryption never trip it.
 *
 * `AesGcm256Cipher` is the concrete implementation: AES-256 in GCM mode,
 * 96-bit random IV per encryption, 128-bit auth tag, output framed as
 * `iv (12 bytes) || tag (16 bytes) || ciphertext (N bytes)`. GCM is
 * authenticated — tampering or a wrong key throws at `final()` rather
 * than silently producing garbage.
 *
 * @see docs/kernel/guides/encryption.md
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ConfigError } from '../exceptions/config_error.ts'

/** IV length for AES-GCM — 12 bytes (96 bits), the GCM-recommended size. */
const IV_LEN = 12
/** GCM auth tag — 16 bytes (128 bits), the GCM standard size. */
const TAG_LEN = 16
/** AES-256 key length. */
const KEY_LEN = 32

/**
 * Base contract. Concrete subclasses override `encrypt` / `decrypt`. The
 * default impl throws — see file header for the rationale.
 */
export class Cipher {
  encrypt(_plaintext: string): Uint8Array {
    throw new ConfigError(
      'Cipher.encrypt called but no encryption key is configured. ' +
        'Register EncryptionProvider with `config.encryption.key` set.',
      { code: 'encryption.not-configured' },
    )
  }
  decrypt(_ciphertext: Uint8Array): string {
    throw new ConfigError(
      'Cipher.decrypt called but no encryption key is configured. ' +
        'Register EncryptionProvider with `config.encryption.key` set.',
      { code: 'encryption.not-configured' },
    )
  }
}

/**
 * AES-256-GCM cipher. The 32-byte key is supplied at construction; see
 * `parseEncryptionKey()` for normalizing hex/base64 strings into bytes.
 *
 * Ciphertext format: `iv (12) || tag (16) || ct (≥1)`. The IV is fresh
 * random per encrypt call — the same plaintext encrypts to different
 * ciphertexts each time, which is what AES-GCM expects (reusing an IV
 * with the same key breaks the security model).
 */
export class AesGcm256Cipher extends Cipher {
  constructor(private readonly key: Uint8Array) {
    super()
    if (key.length !== KEY_LEN) {
      throw new ConfigError(`AesGcm256Cipher: key must be ${KEY_LEN} bytes; got ${key.length}.`, {
        code: 'encryption.bad-key',
      })
    }
  }

  override encrypt(plaintext: string): Uint8Array {
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Uint8Array.from(Buffer.concat([iv, tag, ct]))
  }

  override decrypt(ciphertext: Uint8Array): string {
    if (ciphertext.length < IV_LEN + TAG_LEN) {
      throw new ConfigError(
        `AesGcm256Cipher.decrypt: ciphertext too short (${ciphertext.length} bytes; expected ≥ ${IV_LEN + TAG_LEN}).`,
        { code: 'encryption.bad-ciphertext' },
      )
    }
    const buf = Buffer.from(ciphertext)
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ct = buf.subarray(IV_LEN + TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }
}

/**
 * Normalize a key value to a 32-byte `Uint8Array`. Accepts:
 *   - 64-char hex (`/^[0-9a-fA-F]{64}$/`)
 *   - base64 that decodes to exactly 32 bytes (44 chars padded, 43 unpadded)
 *   - a 32-byte `Uint8Array` / `Buffer`
 *
 * Anything else throws `ConfigError` — better to die at boot than to
 * accidentally derive a 16-byte key from a malformed env var.
 */
export function parseEncryptionKey(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) {
    if (raw.length !== KEY_LEN) {
      throw new ConfigError(`Encryption key: expected ${KEY_LEN} bytes; got ${raw.length}.`, {
        code: 'encryption.bad-key',
      })
    }
    return raw
  }
  if (typeof raw !== 'string') {
    throw new ConfigError('Encryption key: must be a string or Uint8Array.', {
      code: 'encryption.bad-key',
    })
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Uint8Array.from(Buffer.from(raw, 'hex'))
  }
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === KEY_LEN) {
    return Uint8Array.from(decoded)
  }
  throw new ConfigError(
    'Encryption key: expected a 64-char hex string or a base64 string decoding to 32 bytes.',
    { code: 'encryption.bad-key' },
  )
}
