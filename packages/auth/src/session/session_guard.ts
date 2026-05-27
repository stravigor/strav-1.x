/**
 * `SessionGuard` — DB-backed session via a signed cookie.
 *
 * The cookie value is the session row's primary key (a ULID). On every
 * request the guard reads the cookie, asks `SessionRepository.findValid`
 * to look up the row AND check expiry in one round-trip, then resolves
 * the user through the app-supplied `userResolver`.
 *
 * Login mints a fresh session, sets the cookie. Logout deletes the row
 * and clears the cookie.
 *
 * Trade-offs deferred to follow-up slices:
 *   - **No sliding-window expiry.** A session's `expires_at` is set at
 *     login and not bumped on subsequent activity. Apps that want active
 *     users to stay logged in will get a `touch()` enrichment later.
 *   - **No session-id rotation on login.** Standard session-fixation
 *     prevention. Apps with sensitive auth should call a `regenerate()`
 *     helper when it lands.
 *   - **No payload column.** Flash messages / CSRF / locale storage need
 *     a `jsonb` payload column — separate slice.
 *
 * Production replacement for the `MemoryGuard` (which holds sessions in
 * a process-local Map). API is identical so apps swap `driver: 'memory'`
 * → `driver: 'session'` without touching middleware or handlers.
 */

import type { HttpContext } from '@strav/http'
import { ulid } from '@strav/kernel'
import type { Authenticatable } from '../authenticatable.ts'
import type { Guard, LoginOptions } from '../guard.ts'
import type { Session } from './session.ts'
import type { SessionRepository } from './session_repository.ts'

export interface SessionGuardOptions {
  /** Stable name; matches `config.auth.guards.<name>`. Default `'session'`. */
  name?: string
  /** Cookie name carrying the session id. Default `'strav_session'`. */
  cookieName?: string
  /** Session lifetime in seconds. Default 14 days. */
  ttlSeconds?: number
  /** Send the cookie only over HTTPS. Default true; flip to false for local HTTP dev. */
  secure?: boolean
  /** Repository used to read/write session rows. */
  sessions: SessionRepository
  /** Loads the user by identifier — typically `(id) => userRepo.find(id)`. */
  userResolver: (id: string) => Authenticatable | null | Promise<Authenticatable | null>
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14 // 14 days

export class SessionGuard<U extends Authenticatable = Authenticatable> implements Guard<U> {
  readonly name: string
  private readonly cookieName: string
  private readonly ttlMs: number
  private readonly secure: boolean
  private readonly sessions: SessionRepository
  private readonly resolveUser: (
    id: string,
  ) => Authenticatable | null | Promise<Authenticatable | null>

  constructor(options: SessionGuardOptions) {
    this.name = options.name ?? 'session'
    this.cookieName = options.cookieName ?? 'strav_session'
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
    this.secure = options.secure ?? true
    this.sessions = options.sessions
    this.resolveUser = options.userResolver
  }

  async authenticate(ctx: HttpContext): Promise<U | null> {
    const sid = ctx.request.cookies[this.cookieName]
    if (!sid) return null
    const session = await this.sessions.findValid(sid)
    if (!session) return null
    const user = await this.resolveUser(session.user_id)
    return (user as U | null) ?? null
  }

  async login(ctx: HttpContext, user: U, _options?: LoginOptions): Promise<void> {
    const id = ulid()
    const expiresAt = new Date(Date.now() + this.ttlMs)
    await this.sessions.create({
      id,
      user_id: user.getAuthIdentifier(),
      expires_at: expiresAt,
    } as Partial<Session>)
    ctx.response.cookie(this.cookieName, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure,
      path: '/',
      expires: expiresAt,
    })
  }

  async logout(ctx: HttpContext): Promise<void> {
    const sid = ctx.request.cookies[this.cookieName]
    if (sid) {
      const session = await this.sessions.find(sid)
      if (session) await this.sessions.delete(session)
    }
    ctx.response.forgetCookie(this.cookieName, { path: '/' })
  }
}
