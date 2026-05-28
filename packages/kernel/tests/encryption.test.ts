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
