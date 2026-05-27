/**
 * `Authenticatable` — the contract every user model implements to participate
 * in the auth flow. Two methods. That's it.
 *
 * `getAuthIdentifier()` returns the primary key (typically a ULID string for
 * Strav apps). The guard stores this in its session/token record so it can
 * recover the user on subsequent requests.
 *
 * `getAuthPassword()` returns the hashed password — the column that
 * `Hasher.verify(plaintext, hash)` checks against. Override the default
 * implementation if your column isn't named `password_hash`.
 *
 * The interface is structural: any object exposing these two methods is
 * `Authenticatable`. No mixin required.
 */

export interface Authenticatable {
  getAuthIdentifier(): string
  getAuthPassword(): string
}

/** Type-guard: does `value` implement the contract? */
export function isAuthenticatable(value: unknown): value is Authenticatable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getAuthIdentifier?: unknown }).getAuthIdentifier === 'function' &&
    typeof (value as { getAuthPassword?: unknown }).getAuthPassword === 'function'
  )
}
