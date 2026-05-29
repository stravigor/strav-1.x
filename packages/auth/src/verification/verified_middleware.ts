/**
 * `verified` middleware — gates a route on `ctx.auth.user.email_verified_at`.
 *
 * Must run after the `auth` middleware (which populates `ctx.auth.user`).
 * Throws `EmailNotVerifiedError` (status 403) when the user is authenticated
 * but hasn't verified their email.
 *
 * Registration:
 *   registry.register('verified', verifiedMiddleware())
 *
 * Usage:
 *   router.get('/billing', handler).middleware(['auth', 'verified'])
 */

import type { MiddlewareFn } from '@strav/http'
import { StravError } from '@strav/kernel'
import '../context_augmentation.ts'

export class EmailNotVerifiedError extends StravError {
  constructor() {
    super('Email address must be verified to access this resource.', {
      code: 'auth.email-not-verified',
      status: 403,
    })
  }
}

export function verifiedMiddleware(): MiddlewareFn {
  return async (ctx, next) => {
    const user = ctx.auth?.user as { email_verified_at?: Date | string | null } | null | undefined
    if (!user?.email_verified_at) {
      throw new EmailNotVerifiedError()
    }
    return next()
  }
}
