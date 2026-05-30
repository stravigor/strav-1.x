/**
 * TTL parsing — `'10m'` / `'1h'` / `'60s'` / number-as-seconds /
 * null|undefined.
 *
 * Returned values are **seconds from now**. The driver converts to
 * absolute timestamps internally.
 *
 * Throws `CacheTtlParseError` for malformed strings — fail fast rather
 * than silently default. The cost of a typo (`'5min'` instead of
 * `'5m'`) being treated as "no expiry" would be cache entries that
 * never go away in production.
 */

import { CacheTtlParseError } from './cache_error.ts'
import type { CacheTtl } from './types.ts'

const SUFFIX_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
}

const TTL_PATTERN = /^\s*(\d+)\s*([smhd]?)\s*$/i

/**
 * Parse a `CacheTtl` into seconds, or `null` for "no expiry".
 *
 *   parseTtl('10m')     → 600
 *   parseTtl('1h')      → 3600
 *   parseTtl('45s')     → 45
 *   parseTtl(300)       → 300
 *   parseTtl(null)      → null
 *   parseTtl(undefined) → null
 *   parseTtl('5min')    → throws CacheTtlParseError
 */
export function parseTtl(ttl: CacheTtl): number | null {
  if (ttl === null || ttl === undefined) return null
  if (typeof ttl === 'number') {
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new CacheTtlParseError(`Cache TTL must be a non-negative finite number; got: ${ttl}`)
    }
    return Math.floor(ttl)
  }
  const match = TTL_PATTERN.exec(ttl)
  if (match === null) {
    throw new CacheTtlParseError(
      `Cache TTL "${ttl}" is not parseable. Expected: a number (seconds), '10m', '1h', '60s', etc.`,
    )
  }
  const amount = Number(match[1])
  const suffix = (match[2] ?? '').toLowerCase()
  const multiplier = suffix === '' ? 1 : SUFFIX_SECONDS[suffix]
  if (multiplier === undefined) {
    throw new CacheTtlParseError(`Cache TTL "${ttl}" has unknown suffix "${suffix}".`)
  }
  return amount * multiplier
}

/**
 * Convert a TTL spec into an absolute "expires at" unix-ms timestamp.
 * Returns `null` when the TTL is null (forever).
 */
export function ttlToExpiresAt(ttl: CacheTtl, now = Date.now()): number | null {
  const seconds = parseTtl(ttl)
  if (seconds === null) return null
  return now + seconds * 1000
}
