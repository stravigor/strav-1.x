/**
 * Path normalization + safety check.
 *
 * All public `Storage` methods funnel input through `normalizePath()`
 * before handing to the driver. The rules:
 *
 *   - POSIX-style only. Backslashes are illegal (would let Windows
 *     callers smuggle path-segment confusion past S3 → FS portability).
 *   - No `..` segments anywhere — even `a/../b` is rejected (collapsing
 *     would conflate two distinct caller intents; rejecting forces
 *     callers to be explicit).
 *   - No absolute paths (leading `/`). The FS driver joins the input
 *     with its `root`; an absolute path would escape that root.
 *   - No empty segments (`a//b`), no `.` segments (`a/./b`) — both
 *     trip the parser on some backends; reject for cross-driver
 *     parity.
 *   - No control characters (< 0x20, 0x7F).
 *   - Leading + trailing whitespace trimmed; bare paths rejected.
 *
 * Throws `StoragePathError` on any rejection. The error includes the
 * offending path so callers can log + fix at the source.
 */

import { StoragePathError } from './storage_error.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point — we reject paths containing them
const CONTROL_CHAR = /[\x00-\x1f\x7f]/

/**
 * Same rules as `normalizePath` but tolerates a trailing `/` —
 * prefixes describe ranges of keys, not individual objects, and
 * `reports/2026/` is the natural shape for "everything under 2026".
 * The trailing slash is preserved on output so drivers can use the
 * result verbatim in their backend's prefix-match logic.
 *
 * The empty string is allowed (return as-is — "everything from root").
 */
export function normalizePrefix(input: string): string {
  if (typeof input !== 'string') {
    throw new StoragePathError(`Storage prefix must be a string; got: ${typeof input}`)
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) return ''
  const hasTrailing = trimmed.endsWith('/')
  const stripped = hasTrailing ? trimmed.slice(0, -1) : trimmed
  if (stripped.length === 0) {
    // Bare "/" — same problem as an absolute path.
    throw new StoragePathError('Storage prefix "/" is not valid — use the empty string for root.')
  }
  const normalized = normalizePath(stripped)
  return hasTrailing ? `${normalized}/` : normalized
}

export function normalizePath(input: string): string {
  if (typeof input !== 'string') {
    throw new StoragePathError(`Storage path must be a string; got: ${typeof input}`)
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new StoragePathError('Storage path is empty.')
  }
  if (trimmed.includes('\\')) {
    throw new StoragePathError(
      `Storage path "${trimmed}" contains backslashes — use forward slashes only.`,
      { context: { path: trimmed } },
    )
  }
  if (trimmed.startsWith('/')) {
    throw new StoragePathError(
      `Storage path "${trimmed}" must be relative — leading "/" not allowed.`,
      { context: { path: trimmed } },
    )
  }
  if (CONTROL_CHAR.test(trimmed)) {
    throw new StoragePathError(`Storage path "${trimmed}" contains a control character.`, {
      context: { path: trimmed },
    })
  }
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new StoragePathError(
        `Storage path "${trimmed}" has an empty segment (consecutive slashes).`,
        { context: { path: trimmed } },
      )
    }
    if (segment === '..') {
      throw new StoragePathError(
        `Storage path "${trimmed}" contains ".." — directory traversal not allowed.`,
        { context: { path: trimmed } },
      )
    }
    if (segment === '.') {
      throw new StoragePathError(`Storage path "${trimmed}" contains "." segment — strip it.`, {
        context: { path: trimmed },
      })
    }
  }
  return trimmed
}
