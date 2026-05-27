/**
 * Cryptographic helpers — thin wrappers over `node:crypto`.
 *
 * Use these for random tokens, fingerprints, signed values, and constant-time
 * comparisons. Password hashing (bcrypt/argon2) belongs in `@strav/auth`.
 *
 * @see docs/kernel/api.md
 */

import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto'

/**
 * Cryptographically-strong random bytes. Defaults to 32 bytes (256 bits) —
 * enough entropy for session tokens, signing keys, etc.
 */
export function randomBytes(byteLength = 32): Buffer {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new TypeError('randomBytes: byteLength must be a positive integer')
  }
  return nodeRandomBytes(byteLength)
}

/**
 * Random URL-safe token. Defaults to 32 random bytes → 43-character base64url
 * string. Use as opaque session/CSRF/API tokens.
 */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

/** SHA-256 hex digest of a string or byte buffer. */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** HMAC-SHA256 hex digest. */
export function hmacSha256(key: string | Uint8Array, input: string | Uint8Array): string {
  return createHmac('sha256', key).update(input).digest('hex')
}

/**
 * Constant-time equality check. Returns `false` (without leaking length info)
 * when inputs differ in length. Always use this to compare secrets — `===`
 * leaks timing info that lets attackers brute-force token bytes.
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const bufA = typeof a === 'string' ? Buffer.from(a, 'utf8') : Buffer.from(a)
  const bufB = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return nodeTimingSafeEqual(bufA, bufB)
}

/** UUID v4 (RFC 4122). Re-export of `node:crypto`'s `randomUUID`. */
export function randomUUID(): string {
  return nodeRandomUUID()
}
