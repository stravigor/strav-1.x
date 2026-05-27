/**
 * `Guard` — the strategy for identifying a user on a request.
 *
 * Implementations recover the user from whatever the wire carries — a
 * session cookie, a bearer token, a JWT. The framework hands the
 * `HttpContext` to `authenticate(ctx)` once per request; the guard
 * inspects it, looks up the user, and returns the `Authenticatable`
 * instance (or `null` for anonymous).
 *
 * Login / logout side-effects (writing a session, issuing a token) are
 * the guard's responsibility — they're optional, since some guards
 * (JWT, stateless API tokens minted elsewhere) don't have a notion of
 * "login this request".
 *
 * @see docs/auth/api.md
 */

import type { HttpContext } from '@strav/http'
import type { Authenticatable } from './authenticatable.ts'

export interface LoginOptions {
  /** Persist the credential beyond the current session (cookie/token TTL). */
  remember?: boolean
}

export interface Guard<U extends Authenticatable = Authenticatable> {
  /** Stable name; matches `config.auth.guards.<name>`. */
  readonly name: string

  /** Recover the user for this request, if any. Called once per request. */
  authenticate(ctx: HttpContext): U | null | Promise<U | null>

  /** Sign a user in for subsequent requests. Optional — guards without server-side state can throw. */
  login(ctx: HttpContext, user: U, options?: LoginOptions): void | Promise<void>

  /** Forget the user. Optional. */
  logout(ctx: HttpContext): void | Promise<void>
}
