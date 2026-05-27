/**
 * `TokenGuard` — bearer-token guard. Authenticates the request via an
 * `Authorization: Bearer <token>` header (the header name is
 * configurable; the scheme is also configurable for non-standard
 * setups, but `Bearer` is the right default).
 *
 * Tokens are minted out-of-band by app code calling
 * `AccessTokenRepository.createToken(userId, name, opts?)`. The guard's
 * job is verification, not minting — `login(ctx, user)` therefore
 * throws (there's nothing analogous to "log in for this request" with
 * bearer tokens; the client either has a valid token or it doesn't).
 *
 * `logout(ctx)` revokes the *current* request's token — deletes the
 * row matched by `findByPlaintext` on the inbound header. Useful for
 * a `DELETE /api/me/sessions/current` endpoint. To revoke all tokens
 * for a user, call `AccessTokenRepository.revokeAllForUser(id)`.
 *
 * Deferred (each lands as its own slice):
 *   - **`last_used_at` updates** — writing on every request is
 *     prohibitively expensive without batching. Lands with a
 *     write-batching slice.
 *   - **Abilities / scopes** — token-scoped permissions. Lands with
 *     the auth policies slice.
 *   - **`ctx.token` cache** — the authenticated AccessToken row isn't
 *     exposed to handlers today. Lands when a use case shows up
 *     ("list this token's abilities," "show token name on /me").
 */

import type { HttpContext } from '@strav/http'
import type { Authenticatable } from '../authenticatable.ts'
import type { Guard, LoginOptions } from '../guard.ts'
import type { AccessTokenRepository } from './access_token_repository.ts'

export interface TokenGuardOptions {
  /** Stable name; matches `config.auth.guards.<name>`. Default `'token'`. */
  name?: string
  /** Header to read the token from. Default `'authorization'`. */
  headerName?: string
  /** Scheme prefix. Default `'Bearer'`. Compared case-insensitively. */
  scheme?: string
  /** Repository for reads + revocations. */
  tokens: AccessTokenRepository
  /** Loads the user by identifier — typically `(id) => userRepo.find(id)`. */
  userResolver: (id: string) => Authenticatable | null | Promise<Authenticatable | null>
}

export class TokenGuard<U extends Authenticatable = Authenticatable> implements Guard<U> {
  readonly name: string
  private readonly headerName: string
  private readonly scheme: string
  private readonly tokens: AccessTokenRepository
  private readonly resolveUser: (
    id: string,
  ) => Authenticatable | null | Promise<Authenticatable | null>

  constructor(options: TokenGuardOptions) {
    this.name = options.name ?? 'token'
    this.headerName = (options.headerName ?? 'authorization').toLowerCase()
    this.scheme = (options.scheme ?? 'Bearer').toLowerCase()
    this.tokens = options.tokens
    this.resolveUser = options.userResolver
  }

  async authenticate(ctx: HttpContext): Promise<U | null> {
    const plaintext = this.extractToken(ctx)
    if (!plaintext) return null
    const row = await this.tokens.findByPlaintext(plaintext)
    if (!row) return null
    const user = await this.resolveUser(row.user_id)
    return (user as U | null) ?? null
  }

  /**
   * Bearer tokens don't have a "log in for this request" notion — tokens
   * are minted out-of-band. Throwing here surfaces the misuse rather
   * than silently doing nothing.
   */
  async login(_ctx: HttpContext, _user: U, _options?: LoginOptions): Promise<void> {
    throw new Error(
      `TokenGuard "${this.name}": login() is not supported — bearer tokens are minted via AccessTokenRepository.createToken(), not by a login flow.`,
    )
  }

  /**
   * Revoke the current request's token (if present). Idempotent: missing
   * header / invalid token / already-deleted row all no-op.
   */
  async logout(ctx: HttpContext): Promise<void> {
    const plaintext = this.extractToken(ctx)
    if (!plaintext) return
    const row = await this.tokens.findByPlaintext(plaintext)
    if (row) await this.tokens.delete(row)
  }

  /**
   * Pull the bearer value off the configured header. Returns `null` for
   * any of: missing header, wrong scheme, empty token. Whitespace
   * tolerated between scheme and value.
   */
  private extractToken(ctx: HttpContext): string | null {
    const raw = ctx.request.headers.get(this.headerName)
    if (!raw) return null
    const trimmed = raw.trim()
    const sep = trimmed.indexOf(' ')
    if (sep < 0) return null
    const scheme = trimmed.slice(0, sep).toLowerCase()
    if (scheme !== this.scheme) return null
    const value = trimmed.slice(sep + 1).trim()
    return value.length > 0 ? value : null
  }
}
