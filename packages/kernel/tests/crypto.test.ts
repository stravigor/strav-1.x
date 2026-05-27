import { describe, expect, test } from 'bun:test'

import {
  constantTimeEqual,
  hmacSha256,
  randomBytes,
  randomToken,
  randomUUID,
  sha256,
} from '../src/helpers/crypto.ts'

describe('randomBytes', () => {
  test('returns a Buffer of the requested length', () => {
    const out = randomBytes(16)
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.length).toBe(16)
  })

  test('defaults to 32 bytes (256 bits)', () => {
    expect(randomBytes().length).toBe(32)
  })

  test('successive calls are not equal (entropy sanity check)', () => {
    const a = randomBytes(32)
    const b = randomBytes(32)
    expect(a.equals(b)).toBe(false)
  })

  test('rejects non-positive or non-integer lengths', () => {
    expect(() => randomBytes(0)).toThrow(TypeError)
    expect(() => randomBytes(-1)).toThrow(TypeError)
    expect(() => randomBytes(1.5)).toThrow(TypeError)
    expect(() => randomBytes(Number.NaN)).toThrow(TypeError)
  })
})

describe('randomToken', () => {
  test('returns a base64url string of the expected length', () => {
    // 32 bytes → 43 base64url chars (no padding)
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('respects custom byte length', () => {
    // 12 bytes → 16 base64url chars
    expect(randomToken(12)).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  test('uses URL-safe alphabet — no +, /, =', () => {
    for (let i = 0; i < 20; i++) {
      const token = randomToken()
      expect(token).not.toContain('+')
      expect(token).not.toContain('/')
      expect(token).not.toContain('=')
    }
  })

  test('successive tokens differ', () => {
    expect(randomToken()).not.toBe(randomToken())
  })
})

describe('sha256', () => {
  test('matches known vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('accepts Uint8Array input', () => {
    const bytes = new TextEncoder().encode('abc')
    expect(sha256(bytes)).toBe(sha256('abc'))
  })

  test('is deterministic', () => {
    expect(sha256('strav')).toBe(sha256('strav'))
  })
})

describe('hmacSha256', () => {
  test('matches an RFC 4231 test vector', () => {
    // Test Case 1 from RFC 4231
    const key = Buffer.from('0b'.repeat(20), 'hex')
    const data = Buffer.from('Hi There', 'utf8')
    expect(hmacSha256(key, data)).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })

  test('is deterministic for the same key + input', () => {
    expect(hmacSha256('k', 'msg')).toBe(hmacSha256('k', 'msg'))
  })

  test('different keys produce different MACs', () => {
    expect(hmacSha256('k1', 'msg')).not.toBe(hmacSha256('k2', 'msg'))
  })
})

describe('constantTimeEqual', () => {
  test('returns true for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
  })

  test('returns false for different strings of equal length', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  test('returns false for strings of different length without comparing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', 'a')).toBe(false)
  })

  test('handles empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  test('compares Uint8Array buffers', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 3])
    const c = new Uint8Array([1, 2, 4])
    expect(constantTimeEqual(a, b)).toBe(true)
    expect(constantTimeEqual(a, c)).toBe(false)
  })

  test('handles mixed string + buffer of equal byte content', () => {
    const s = 'hello'
    const b = new TextEncoder().encode('hello')
    expect(constantTimeEqual(s, b)).toBe(true)
  })

  test('correctly handles multi-byte UTF-8 (byte length, not char length)', () => {
    // "é" is 2 bytes UTF-8; "e" is 1 byte. Different byte lengths → false.
    expect(constantTimeEqual('é', 'e')).toBe(false)
  })
})

describe('randomUUID', () => {
  test('returns a v4-shaped UUID', () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  test('successive UUIDs differ', () => {
    expect(randomUUID()).not.toBe(randomUUID())
  })
})
