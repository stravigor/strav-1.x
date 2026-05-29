/**
 * `SocialProfile` — normalized user-info shape across providers.
 * The native provider object is on `.raw`; apps reach there for
 * fields the framework doesn't normalize (Line's `pictureUrl`
 * vs Google's `picture` collapse to `avatarUrl`; Line's
 * `displayName` collapses to `name`).
 *
 * Provider divergence the framework intentionally surfaces:
 *
 *   - `email` is optional. Line gives it only when the `email`
 *     scope is requested AND the user accepts; Facebook gives it
 *     only if the app is approved for `email`. Apps that need it
 *     check capability AND check `profile.email`.
 *
 *   - `emailVerified` is true only when the provider asserts it.
 *     Google + Line always assert; Facebook never does — apps
 *     verify themselves.
 *
 *   - `id` is the provider-native subject id. Globally unique
 *     within the provider's namespace, not across providers.
 *     The `(provider, id)` pair is what `social_account` rows
 *     key on (slice 8.5).
 */

export interface SocialProfile {
  /** Provider-native user id (`sub` in OIDC, `userId` in Line, `id` in Facebook). */
  id: string
  /** Driver name — `'line'` / `'google'` / `'facebook'`. */
  provider: string
  email?: string
  emailVerified?: boolean
  name?: string
  avatarUrl?: string
  locale?: string
  metadata: Record<string, unknown>
  raw: unknown
}
