/**
 * `guestMiddleware` — the inverse of `auth`: allow only unauthenticated requests.
 *
 * Typical use: login / signup screens that shouldn't be reachable by users who
 * are already signed in (redirect them to the dashboard instead). For now we
 * throw `AuthError('auth.already-authenticated', status 403)`; once the view
 * package ships, the default exception handler can redirect HTML requests
 * to the post-login route.
 */

import type { MiddlewareFn } from '@strav/http'
import { AuthorizationError } from '@strav/kernel'

// Side-effect import — installs the HttpContext.auth type augmentation so
// `ctx.auth` is in scope when this middleware compiles.
import '../context_augmentation.ts'

export interface GuestMiddlewareOptions {
  guard?: string
}

export function guestMiddleware(options: GuestMiddlewareOptions = {}): MiddlewareFn {
  return async (ctx, next) => {
    if (!ctx.auth) return next()
    const view = options.guard ? ctx.auth.guard(options.guard) : ctx.auth
    await view.populate()
    if (view.user !== null) {
      throw new AuthorizationError('Already authenticated.', {
        code: 'auth.already-authenticated',
        context: options.guard ? { guard: options.guard } : undefined,
      })
    }
    return next()
  }
}
