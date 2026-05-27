/**
 * Widen `@strav/http`'s `HttpContext` with an `auth` property.
 *
 * Importing this file (which the package barrel does) installs the
 * augmentation globally — every `HttpContext` in a TS project that depends on
 * `@strav/auth` sees `ctx.auth`. The runtime population happens via the
 * context enricher installed by `AuthProvider.boot()`.
 *
 * Apps that don't install `@strav/auth` see `ctx.auth` as nonexistent; the
 * type widening only takes effect for projects that depend on the auth
 * package, so there's no false-positive completion across the workspace.
 */

import type { AuthContext } from './auth_context.ts'

declare module '@strav/http' {
  interface HttpContextExtensions {
    /**
     * Per-request authentication façade. Populated by the auth context
     * enricher before any middleware runs. Typed optional because the
     * underlying `HttpContext` class in `@strav/http` doesn't declare it —
     * the property is set dynamically by `AuthProvider`'s enricher.
     *
     * In a handler, prefer the non-null assertion (`ctx.auth!`) once the
     * `auth` middleware has run; the middleware throws `auth.not-wired` if
     * the property isn't populated, which is the catchable signal that
     * `AuthProvider` wasn't registered.
     */
    auth?: AuthContext
  }
}
