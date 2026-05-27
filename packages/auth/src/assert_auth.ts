/**
 * `assertAuth(ctx)` — narrows `ctx.auth` from `AuthContext | undefined` to
 * `AuthContext`, throwing a clear error if `AuthProvider` wasn't wired.
 *
 * Useful in handler/middleware code that wants a non-null `AuthContext`
 * without sprinkling `ctx.auth!` everywhere (which biome flags). The check
 * is the same one the `auth` middleware does internally — if you've already
 * run that middleware on the route, `assertAuth` never throws.
 */

// `HttpContextApi` is the *interface* form (the class type doesn't pick up
// interface augmentations because classes don't inherit them at the class-type
// level — only the interface they `implements` gets widened).
import type { HttpContextApi } from '@strav/http'

// Side-effect — installs the HttpContext.auth augmentation so `ctx.auth` is
// in scope on `HttpContextApi`.
import './context_augmentation.ts'
import type { AuthContext } from './auth_context.ts'

export function assertAuth(ctx: HttpContextApi): AuthContext {
  if (!ctx.auth) {
    throw new Error(
      'assertAuth(ctx): ctx.auth is not wired. Register AuthProvider in your application.',
    )
  }
  return ctx.auth
}
