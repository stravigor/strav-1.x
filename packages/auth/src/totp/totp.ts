/**
 * TOTP (Time-based One-Time Passwords, RFC 6238) utilities.
 *
 * Three functions — `generateSecret`, `qrUri`, `verify` — cover the full
 * TOTP lifecycle. No external dep; uses the `node:crypto` HMAC primitives
 * available in Bun.
 *
 * Algorithm sketch (RFC 6238 / HOTP RFC 4226):
 *   1. `T = floor(unix_seconds / period)` — current 30-second window.
 *   2. `HMAC-SHA1(secret, T as 8-byte big-endian)`.
 *   3. Dynamic truncation: read the offset from the last nibble, extract
 *      4 bytes at that offset, mask the top bit, mod 10^digits.
 *
 * `verify` checks the current window ± `window` steps to tolerate clock
 * skew on mobile devices.
 *
 * The secret format is base32 (RFC 4648, no-padding) — this is what
 * authenticator apps (Google Authenticator, Authy, 1Password, etc.)
 * expect in the `otpauth://` QR URI. The `encode` / `decode` helpers
 * here implement only the subset used by TOTP (5-bit groups, uppercase,
 * no padding).
 *
 * Encryption of `totp_secret` at rest:
 *   Use `@encrypt` on the user schema field. The TOTP helpers work with
 *   the plaintext secret; decryption is handled by the repository layer
 *   before the value reaches your controller.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { StravError } from '@strav/kernel'

export class AuthError extends StravError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, { code: 'auth.totp-error', status: 401 }, options)
  }
}

export interface TotpOptions {
  /** Number of digits. Default 6. */
  digits?: number
  /** Window size in steps to tolerate clock skew (each step = period). Default 1. */
  window?: number
  /** Step period in seconds. Default 30. */
  period?: number
}

/**
 * Generate a random 20-byte TOTP secret encoded as base32.
 * Store this (ideally encrypted with `@encrypt`) on the user record.
 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * Build the `otpauth://totp/…` URI that apps display as a QR code for
 * the user to scan with their authenticator app.
 *
 * @param secret  The base32-encoded secret from `generateSecret()`.
 * @param account User identifier (email or username). Shows in the app.
 * @param issuer  App name. Shows in the app as the account label prefix.
 */
export function qrUri(secret: string, account: string, issuer: string): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Verify a 6-digit code against the stored secret.
 *
 * Returns `true` when the code is valid within ±`window` time steps of the
 * current time. Returns `false` for invalid/expired codes — the caller decides
 * how many failures to allow before locking the account.
 */
export function verify(secret: string, code: string, options: TotpOptions = {}): boolean {
  const { digits = 6, window = 1, period = 30 } = options
  const key = base32Decode(secret)
  const now = Math.floor(Date.now() / 1000 / period)
  for (let i = -window; i <= window; i++) {
    if (hotp(key, now + i, digits) === code.replace(/\s/g, '')) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// HOTP (RFC 4226)
// ─────────────────────────────────────────────────────────────────────────────

function hotp(key: Buffer, counter: number, digits: number): string {
  // Encode counter as 8-byte big-endian.
  const msg = Buffer.alloc(8)
  // counter fits in 32 bits for any practical TOTP window.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  msg.writeUInt32BE(counter >>> 0, 4)

  const hmac = createHmac('sha1', key).update(msg).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const otp =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)
  return String(otp % 10 ** digits).padStart(digits, '0')
}

// ─────────────────────────────────────────────────────────────────────────────
// Base32 (RFC 4648, no padding, uppercase)
// ─────────────────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer | Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(value >>> bits) & 31]
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode(str: string): Buffer {
  const s = str.replace(/=+$/, '').toUpperCase()
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of s) {
    const idx = ALPHABET.indexOf(char)
    if (idx < 0) continue // skip whitespace or invalid chars
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 255)
    }
  }
  return Buffer.from(bytes)
}
