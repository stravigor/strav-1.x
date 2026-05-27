/**
 * `authMiddleware` — gate that requires an authenticated user.
 *
 * Registered as the `auth` middleware. Per-route variants pick the guard via
 * `auth:guardName` (factory form, parsed by `MiddlewareRegistry`).
 *
 * On miss: throws `AuthError('auth.not-authenticated', status 401)`. The
 * default `ExceptionHandler` maps it to a 401 response — HTML responses
 * become a redirect to the configured login route once `@strav/view` and
 * the `loginRoute` config land; JSON responses stay at 401.
 */

import type { MiddlewareFn } from '@strav/http'
import { AuthError } from '@strav/kernel'

// Side-effect import — installs the HttpContext.auth type augmentation so
// `ctx.auth` is in scope when this middleware compiles.
import '../context_augmentation.ts'

export interface AuthMiddlewareOptions {
  /** Name of the guard to use. Default: the AuthManager's default guard. */
  guard?: string
}

export function authMiddleware(options: AuthMiddlewareOptions = {}): MiddlewareFn {
  return async (ctx, next) => {
    if (!ctx.auth) {
      throw new AuthError('auth middleware requires `ctx.auth` (AuthProvider not wired?).', {
        code: 'auth.not-wired',
      })
    }
    const view = options.guard ? ctx.auth.guard(options.guard) : ctx.auth
    await view.populate()
    if (view.user === null) {
      throw new AuthError('Authentication required.', {
        code: 'auth.not-authenticated',
        context: options.guard ? { guard: options.guard } : undefined,
      })
    }
    return next()
  }
}
