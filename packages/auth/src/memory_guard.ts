/**
 * `MemoryGuard` — in-process guard for tests and dev.
 *
 * Holds an `Authenticatable` per-request via a cookie that maps to an
 * in-memory map of `(opaque-id → user)`. Login mints a fresh opaque id,
 * sets the cookie, stashes the user; authenticate reads the cookie and
 * looks up the user; logout drops the entry and clears the cookie.
 *
 * **Not for production.** State is per-process, dies on restart, and the
 * `users` map grows unbounded. Real session storage (`SessionGuard`) +
 * opaque tokens (`TokenGuard`) land when `@strav/database` ships.
 *
 * The cookie name and TTL are configurable for parity with the real
 * guards' surface, but the guard's primary value is "drop into a test,
 * call `ctx.auth.login(user)`, the next request sees them."
 */

import type { HttpContext } from '@strav/http'
import { ulid } from '@strav/kernel'
import type { Authenticatable } from './authenticatable.ts'
import type { Guard, LoginOptions } from './guard.ts'

export interface MemoryGuardOptions {
  /** Stable name; matches `config.auth.guards.<name>`. */
  name?: string
  /** Cookie name carrying the opaque session id. */
  cookieName?: string
  /** Function that loads a user by identifier — typically a UserRepository call. */
  userResolver: (id: string) => Authenticatable | null | Promise<Authenticatable | null>
}

/** Module-level store — survives across requests within one process. */
const SESSIONS = new Map<string, string>() // opaque cookie value → user identifier

export class MemoryGuard<U extends Authenticatable = Authenticatable> implements Guard<U> {
  readonly name: string
  private readonly cookieName: string
  private readonly resolveUser: (
    id: string,
  ) => Authenticatable | null | Promise<Authenticatable | null>

  constructor(options: MemoryGuardOptions) {
    this.name = options.name ?? 'memory'
    this.cookieName = options.cookieName ?? 'strav_memory_session'
    this.resolveUser = options.userResolver
  }

  async authenticate(ctx: HttpContext): Promise<U | null> {
    const sid = ctx.request.cookies[this.cookieName]
    if (!sid) return null
    const userId = SESSIONS.get(sid)
    if (!userId) return null
    const user = await this.resolveUser(userId)
    return (user as U | null) ?? null
  }

  async login(ctx: HttpContext, user: U, _options?: LoginOptions): Promise<void> {
    const sid = ulid()
    SESSIONS.set(sid, user.getAuthIdentifier())
    ctx.response.cookie(this.cookieName, sid, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    })
  }

  async logout(ctx: HttpContext): Promise<void> {
    const sid = ctx.request.cookies[this.cookieName]
    if (sid) SESSIONS.delete(sid)
    ctx.response.forgetCookie(this.cookieName, { path: '/' })
  }

  /** Test helper: wipe every session in the in-memory store. */
  static clearAllSessions(): void {
    SESSIONS.clear()
  }
}
