/**
 * ULID — Universally-unique Lexicographically-sortable IDentifier.
 *
 * 26-character Crockford-Base32 string: 10 chars of millisecond timestamp +
 * 16 chars of randomness. Lexicographic sort matches creation order, so they
 * make excellent primary keys for time-ordered tables.
 *
 * This generator is **monotonic**: when called twice in the same millisecond,
 * the random portion is incremented rather than re-randomized, so the second
 * ULID sorts strictly after the first.
 *
 * @see docs/kernel/api.md
 * @see https://github.com/ulid/spec
 */

import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16
const ULID_LEN = TIME_LEN + RANDOM_LEN
const MAX_TIME = 0xffff_ffff_ffff // 48 bits — year 10889

// Decode table built once. Includes Crockford's lenient mappings:
// I/i/L/l → 1, O/o → 0. (The canonical alphabet already excludes I/L/O/U.)
const DECODE: Record<string, number> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < ALPHABET.length; i++) {
    const c = ALPHABET[i] as string
    m[c] = i
    m[c.toLowerCase()] = i
  }
  m.I = m.i = m.L = m.l = 1
  m.O = m.o = 0
  return m
})()

// Monotonic state — module-local. The risk of cross-process collisions in
// the same millisecond is acceptable for application IDs; if a stronger
// guarantee is needed, persist seed state externally.
let lastTimestamp = -1
// Use `Uint8Array<ArrayBufferLike>` so we can store either the ArrayBuffer-backed
// freshly-allocated array OR the Buffer-backed bytes returned from node:crypto.
let lastRandom: Uint8Array<ArrayBufferLike> = new Uint8Array(10)

/**
 * Generate a new ULID. The optional `timestamp` parameter overrides the wall
 * clock — useful in tests with a fixed `Clock`.
 *
 * Throws if `timestamp` is negative, non-finite, or exceeds the 48-bit window.
 */
export function ulid(timestamp = Date.now()): string {
  validateTimestamp(timestamp)

  let random: Uint8Array
  if (timestamp === lastTimestamp) {
    random = new Uint8Array(lastRandom)
    incrementRandom(random)
  } else {
    // Copy into a fresh Uint8Array so the type is Uint8Array<ArrayBuffer>
    // (not Buffer's Uint8Array<ArrayBufferLike>, which TS rejects under
    // the new lib.dom typings).
    random = new Uint8Array(randomBytes(10))
    lastTimestamp = timestamp
  }
  lastRandom = random

  return encodeTimestamp(timestamp) + encodeRandom(random)
}

/** Decode the timestamp embedded in a ULID. */
export function decodeUlidTime(value: string): number {
  if (typeof value !== 'string' || value.length !== ULID_LEN) {
    throw new TypeError(`decodeUlidTime: expected a 26-character ULID, got ${typeof value}`)
  }
  let time = 0
  for (let i = 0; i < TIME_LEN; i++) {
    const c = value[i] as string
    const v = DECODE[c]
    if (v === undefined) {
      throw new TypeError(`decodeUlidTime: invalid character "${c}" at position ${i}`)
    }
    time = time * 32 + v
  }
  return time
}

/** `true` iff `value` is a well-formed ULID string. */
export function isUlid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== ULID_LEN) return false
  for (let i = 0; i < ULID_LEN; i++) {
    if (DECODE[value[i] as string] === undefined) return false
  }
  return true
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

function validateTimestamp(t: number): void {
  if (!Number.isFinite(t) || t < 0) {
    throw new TypeError('ulid: timestamp must be a finite non-negative number')
  }
  if (t > MAX_TIME) {
    throw new RangeError('ulid: timestamp exceeds the 48-bit window (max year 10889)')
  }
}

/** Encode a 48-bit timestamp as 10 base32 characters. */
function encodeTimestamp(time: number): string {
  let str = ''
  let t = time
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32
    str = (ALPHABET[mod] as string) + str
    t = (t - mod) / 32
  }
  return str
}

/**
 * Encode 80 bits of randomness as 16 base32 characters.
 *
 * We feed bytes left-to-right into a sliding bit-buffer and emit a character
 * whenever ≥5 bits accumulate. After each emit we mask `buffer` to its bottom
 * `bits` bits so it never overflows JS's 32-bit bitwise range.
 */
function encodeRandom(bytes: Uint8Array): string {
  let buffer = 0
  let bits = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | (bytes[i] as number)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(buffer >>> bits) & 0x1f]
    }
    buffer &= (1 << bits) - 1
  }
  return out
}

/** Increment a 10-byte big-endian random value in place. Throws on overflow. */
function incrementRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const b = bytes[i] as number
    if (b === 0xff) {
      bytes[i] = 0
      continue
    }
    bytes[i] = b + 1
    return
  }
  throw new Error('ulid: monotonic overflow within the same millisecond')
}
