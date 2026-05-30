import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  AesGcm256Cipher,
  Application,
  Cipher,
  ConfigError,
  ConfigProvider,
  EncryptionProvider,
  parseEncryptionKey,
} from '../src/index.ts'

const KEY_BYTES = Uint8Array.from(randomBytes(32))
const KEY_HEX = Buffer.from(KEY_BYTES).toString('hex')
const KEY_BASE64 = Buffer.from(KEY_BYTES).toString('base64')

// ─────────────────────────────────────────────────────────────────────────────
// parseEncryptionKey
// ─────────────────────────────────────────────────────────────────────────────

describe('parseEncryptionKey', () => {
  test('passes through a 32-byte Uint8Array', () => {
    const out = parseEncryptionKey(KEY_BYTES)
    expect(out).toEqual(KEY_BYTES)
  })

  test('rejects a Uint8Array of the wrong length', () => {
    expect(() => parseEncryptionKey(new Uint8Array(16))).toThrow(ConfigError)
  })

  test('decodes a 64-char hex string', () => {
    expect(parseEncryptionKey(KEY_HEX)).toEqual(KEY_BYTES)
  })

  test('decodes a 32-byte base64 string', () => {
    expect(parseEncryptionKey(KEY_BASE64)).toEqual(KEY_BYTES)
  })

  test('rejects a short hex string', () => {
    expect(() => parseEncryptionKey('0123')).toThrow(ConfigError)
  })

  test('rejects a base64 string that decodes to the wrong length', () => {
    // 'aGVsbG8=' decodes to "hello" — only 5 bytes.
    expect(() => parseEncryptionKey('aGVsbG8=')).toThrow(ConfigError)
  })

  test('rejects non-string / non-Uint8Array input', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately testing a bad input.
    expect(() => parseEncryptionKey(42 as any)).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Base Cipher class — throws by default
// ─────────────────────────────────────────────────────────────────────────────

describe('Cipher (base, unconfigured)', () => {
  test('encrypt throws ConfigError with a "not-configured" code', () => {
    const c = new Cipher()
    try {
      c.encrypt('hello')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).code).toBe('encryption.not-configured')
    }
  })

  test('decrypt throws the same way', () => {
    const c = new Cipher()
    expect(() => c.decrypt(new Uint8Array([0, 1, 2]))).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AesGcm256Cipher — round-trip + tamper detection
// ─────────────────────────────────────────────────────────────────────────────

describe('AesGcm256Cipher', () => {
  test('rejects a wrong-length key at construction', () => {
    expect(() => new AesGcm256Cipher(new Uint8Array(16))).toThrow(ConfigError)
  })

  test('round-trips a UTF-8 string', () => {
    const c = new AesGcm256Cipher(KEY_BYTES)
    const ct = c.encrypt('hello world')
    expect(ct.length).toBeGreaterThan(12 + 16) // iv + tag + ≥1 ct byte
    expect(c.decrypt(ct)).toBe('hello world')
  })

  test('round-trips multi-byte UTF-8', () => {
    const c = new AesGcm256Cipher(KEY_BYTES)
    const plain = 'héllo wörld 🌍 — café'
    expect(c.decrypt(c.encrypt(plain))).toBe(plain)
  })

  test('round-trips an empty string', () => {
    const c = new AesGcm256Cipher(KEY_BYTES)
    expect(c.decrypt(c.encrypt(''))).toBe('')
  })

  test('produces different ciphertexts for the same plaintext (random IV)', () => {
    const c = new AesGcm256Cipher(KEY_BYTES)
    const a = c.encrypt('repeat')
    const b = c.encrypt('repeat')
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    // But both decrypt back to the same value.
    expect(c.decrypt(a)).toBe('repeat')
    expect(c.decrypt(b)).toBe('repeat')
  })

  test('detects tampering via the GCM auth tag', () => {
    const c = new AesGcm256Cipher(KEY_BYTES)
    const ct = c.encrypt('sensitive')
    // Flip a bit in the ciphertext body.
    const tampered = new Uint8Array(ct)
    const idx = tampered.length - 1
    tampered[idx] = (tampered[idx] as number) ^ 0x01
    expect(() => c.decrypt(tampered)).toThrow()
  })

  test('detects a different key (decrypt with a wrong key throws)', () => {
    const a = new AesGcm256Cipher(KEY_BYTES)
    const b = new AesGcm256Cipher(Uint8Array.from(randomBytes(32)))
    const ct = a.encrypt('secret')
    expect(() => b.decrypt(ct)).toThrow()
  })

  test('rejects ciphertext too short to contain iv + tag', () => {
    const c = new AesGcm256Cipher(KEY_BYTES)
    expect(() => c.decrypt(new Uint8Array(10))).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EncryptionProvider — DI wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('EncryptionProvider', () => {
  test('binds Cipher to AesGcm256Cipher when a hex key is configured', async () => {
    const app = new Application().useProviders([
      new ConfigProvider({ encryption: { key: KEY_HEX } }),
      new EncryptionProvider(),
    ])
    await app.start()
    const cipher = app.resolve(Cipher)
    expect(cipher).toBeInstanceOf(AesGcm256Cipher)
    expect(cipher.decrypt(cipher.encrypt('round-trip'))).toBe('round-trip')
    await app.shutdown()
  })

  test('throws at boot when config.encryption is missing', async () => {
    const app = new Application().useProviders([new ConfigProvider({}), new EncryptionProvider()])
    await expect(app.start()).rejects.toBeInstanceOf(ConfigError)
  })

  test('throws at boot on a malformed key', async () => {
    const app = new Application().useProviders([
      new ConfigProvider({ encryption: { key: 'not-a-real-key' } }),
      new EncryptionProvider(),
    ])
    await expect(app.start()).rejects.toBeInstanceOf(ConfigError)
  })

  test('declares the "config" dependency', () => {
    const p = new EncryptionProvider()
    expect(p.dependencies).toEqual(['config'])
    expect(p.name).toBe('encryption')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Key rotation (previousKeys)
// ─────────────────────────────────────────────────────────────────────────────

describe('AesGcm256Cipher — rotation', () => {
  test('options-form constructor accepts a current key + previous-keys ring', () => {
    const k1 = Uint8Array.from(randomBytes(32))
    const k2 = Uint8Array.from(randomBytes(32))
    expect(() => new AesGcm256Cipher({ key: k1, previousKeys: [k2] })).not.toThrow()
  })

  test('decrypts ciphertext written under a previous key after rotation', () => {
    const oldKey = Uint8Array.from(randomBytes(32))
    const newKey = Uint8Array.from(randomBytes(32))

    const oldCipher = new AesGcm256Cipher(oldKey)
    const ct = oldCipher.encrypt('secret-value')

    // After rotation: app boots with new key + old in previousKeys.
    const rotated = new AesGcm256Cipher({ key: newKey, previousKeys: [oldKey] })
    expect(rotated.decrypt(ct)).toBe('secret-value')
  })

  test('new writes go out under the current key', () => {
    const oldKey = Uint8Array.from(randomBytes(32))
    const newKey = Uint8Array.from(randomBytes(32))

    const rotated = new AesGcm256Cipher({ key: newKey, previousKeys: [oldKey] })
    const ct = rotated.encrypt('fresh')

    // A cipher with ONLY the new key can decrypt fresh writes.
    expect(new AesGcm256Cipher(newKey).decrypt(ct)).toBe('fresh')
    // A cipher with ONLY the old key cannot.
    expect(() => new AesGcm256Cipher(oldKey).decrypt(ct)).toThrow()
  })

  test('walks every previous key in order until one verifies', () => {
    const k1 = Uint8Array.from(randomBytes(32))
    const k2 = Uint8Array.from(randomBytes(32))
    const k3 = Uint8Array.from(randomBytes(32))

    const ctUnderK3 = new AesGcm256Cipher(k3).encrypt('three-rotations-ago')
    const rotated = new AesGcm256Cipher({ key: k1, previousKeys: [k2, k3] })
    expect(rotated.decrypt(ctUnderK3)).toBe('three-rotations-ago')
  })

  test('throws with a clear message when no key in the ring verifies', () => {
    const k1 = Uint8Array.from(randomBytes(32))
    const k2 = Uint8Array.from(randomBytes(32))
    const k3 = Uint8Array.from(randomBytes(32))

    const ct = new AesGcm256Cipher(k1).encrypt('mystery')
    const rotated = new AesGcm256Cipher({ key: k2, previousKeys: [k3] })
    expect(() => rotated.decrypt(ct)).toThrow(/did not decrypt under any of the 2 configured key/)
  })

  test('rejects previous keys with the wrong length at construction time', () => {
    const k1 = Uint8Array.from(randomBytes(32))
    expect(() => new AesGcm256Cipher({ key: k1, previousKeys: [new Uint8Array(16)] })).toThrow(
      /previousKeys\[0\] must be 32 bytes/,
    )
  })

  test('EncryptionProvider parses config.encryption.previousKeys (hex / base64 / Uint8Array)', async () => {
    const newKey = Uint8Array.from(randomBytes(32))
    const oldKey = Uint8Array.from(randomBytes(32))

    // Encrypt under the OLD key with a standalone cipher.
    const ct = new AesGcm256Cipher(oldKey).encrypt('via-provider')

    // Boot an Application with rotation config; resolve Cipher, decrypt.
    const app = new Application()
    app.useProviders([
      new ConfigProvider({
        encryption: {
          key: Buffer.from(newKey).toString('hex'),
          previousKeys: [Buffer.from(oldKey).toString('base64')],
        },
      }),
      new EncryptionProvider(),
    ])
    await app.start({ signalHandlers: false })
    try {
      const cipher = app.resolve(Cipher)
      expect(cipher.decrypt(ct)).toBe('via-provider')
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// blindIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('AesGcm256Cipher — blindIndex', () => {
  test('returns a 64-char hex string', () => {
    const cipher = new AesGcm256Cipher(KEY_BYTES)
    const hex = cipher.blindIndex('user@example.com')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })

  test('deterministic — same input under the same key returns the same hex', () => {
    const cipher = new AesGcm256Cipher(KEY_BYTES)
    expect(cipher.blindIndex('hi')).toBe(cipher.blindIndex('hi'))
  })

  test('different keys produce different hashes for the same input', () => {
    const k1 = Uint8Array.from(randomBytes(32))
    const k2 = Uint8Array.from(randomBytes(32))
    expect(new AesGcm256Cipher(k1).blindIndex('x')).not.toBe(
      new AesGcm256Cipher(k2).blindIndex('x'),
    )
  })

  test('different inputs produce different hashes under the same key', () => {
    const cipher = new AesGcm256Cipher(KEY_BYTES)
    expect(cipher.blindIndex('a')).not.toBe(cipher.blindIndex('b'))
  })

  test('always uses the CURRENT key (rotation does not change existing index values for the new key)', () => {
    const oldKey = Uint8Array.from(randomBytes(32))
    const newKey = Uint8Array.from(randomBytes(32))
    const rotated = new AesGcm256Cipher({ key: newKey, previousKeys: [oldKey] })
    // Whatever the rotated cipher returns, it must equal what a fresh
    // cipher built from the same current key produces.
    expect(rotated.blindIndex('x')).toBe(new AesGcm256Cipher(newKey).blindIndex('x'))
  })

  test('base-class blindIndex throws when no encryption is configured', () => {
    expect(() => new Cipher().blindIndex('x')).toThrow(/no encryption key is configured/)
  })
})
