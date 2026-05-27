/**
 * `AuthContext` — the per-request façade attached as `ctx.auth`.
 *
 * Each request gets a fresh instance bound to the request's `HttpContext`.
 * The context is a thin shell over an `AuthGuardView` for the default guard:
 *
 *   - `ctx.auth.user` / `.check()` / `.userOrFail()` / `.login()` / `.logout()`
 *     all delegate to the default guard's view.
 *   - `ctx.auth.guard(name)` returns the cached view for that name. When
 *     `name` matches the default guard, the *same* view is returned that
 *     `ctx.auth.*` operates on — so `auth:default` middleware populating
 *     the view also populates `ctx.auth.user`.
 *
 * Per-request views cache the authenticated user; subsequent calls within the
 * same request never re-hit the guard's `authenticate()`.
 */

import type { HttpContext } from '@strav/http'
import { AuthError } from '@strav/kernel'
import type { AuthManager } from './auth_manager.ts'
import type { Authenticatable } from './authenticatable.ts'
import type { Guard, LoginOptions } from './guard.ts'

export class AuthContext<U extends Authenticatable = Authenticatable> {
  private readonly defaultView: AuthGuardView<U>
  private readonly viewCache = new Map<string, AuthGuardView<Authenticatable>>()

  constructor(
    ctx: HttpContext,
    private readonly manager: AuthManager,
  ) {
    const defaultGuard = manager.guard() as Guard<U>
    this.defaultView = new AuthGuardView<U>(ctx, defaultGuard)
    this.viewCache.set(
      defaultGuard.name,
      this.defaultView as unknown as AuthGuardView<Authenticatable>,
    )
  }

  /** The authenticated user (or null). Populated lazily; call `check()` to force. */
  get user(): U | null {
    return this.defaultView.user
  }

  /** Has the default guard recovered a user? Awaits authentication if not yet attempted. */
  check(): Promise<boolean> {
    return this.defaultView.check()
  }

  /** Same as `user`, but throws `AuthError('auth.not-authenticated')` when null. */
  userOrFail(): Promise<U> {
    return this.defaultView.userOrFail()
  }

  /** Sign `user` in via the default guard (sets a session, issues a token, etc.). */
  login(user: U, options?: LoginOptions): Promise<void> {
    return this.defaultView.login(user, options)
  }

  /** Forget the user via the default guard. */
  logout(): Promise<void> {
    return this.defaultView.logout()
  }

  /**
   * Force the default guard to authenticate now and cache the result. Called
   * by the `auth` middleware so route handlers see `ctx.auth.user` without
   * awaiting.
   */
  populate(): Promise<void> {
    return this.defaultView.populate()
  }

  /**
   * Switch to a named guard. Caches views per-request so subsequent calls
   * for the same name return the same view — including the default guard
   * view, so `auth:default-name` middleware populating the view also
   * populates `ctx.auth.user`.
   */
  guard<G extends Authenticatable = Authenticatable>(name: string): AuthGuardView<G> {
    const cached = this.viewCache.get(name)
    if (cached) return cached as unknown as AuthGuardView<G>
    const guard = this.manager.guard(name) as Guard<G>
    // Use the existing ctx via the default view's ctx reference.
    const view = new AuthGuardView<G>(this.defaultView.ctxRef, guard)
    this.viewCache.set(name, view as unknown as AuthGuardView<Authenticatable>)
    return view
  }
}

/**
 * Per-request view bound to one guard. Caches its `populated` state so the
 * guard's `authenticate()` runs at most once per request.
 */
export class AuthGuardView<U extends Authenticatable = Authenticatable> {
  private cachedUser: U | null = null
  private populated = false

  constructor(
    /** Public so `AuthContext.guard()` can build sibling views on the same ctx. */
    readonly ctxRef: HttpContext,
    private readonly guardImpl: Guard<U>,
  ) {}

  get name(): string {
    return this.guardImpl.name
  }

  get user(): U | null {
    return this.cachedUser
  }

  async check(): Promise<boolean> {
    await this.populate()
    return this.cachedUser !== null
  }

  async userOrFail(): Promise<U> {
    await this.populate()
    if (this.cachedUser === null) {
      throw new AuthError(`Not authenticated on guard "${this.guardImpl.name}".`, {
        code: 'auth.not-authenticated',
        context: { guard: this.guardImpl.name },
      })
    }
    return this.cachedUser
  }

  async login(user: U, options?: LoginOptions): Promise<void> {
    await this.guardImpl.login(this.ctxRef, user, options)
    this.cachedUser = user
    this.populated = true
  }

  async logout(): Promise<void> {
    await this.guardImpl.logout(this.ctxRef)
    this.cachedUser = null
    this.populated = true
  }

  async populate(): Promise<void> {
    if (this.populated) return
    this.cachedUser = (await this.guardImpl.authenticate(this.ctxRef)) ?? null
    this.populated = true
  }
}
