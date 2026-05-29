/**
 * `@strav/social` — runtime config shape.
 *
 * Multi-provider by default — apps register one entry per
 * provider they want available (e.g. `line`, `google`,
 * `facebook`). The driver field discriminates the adapter; the
 * rest is driver-specific (`clientId`, `clientSecret`, …).
 */

export interface SocialConfig {
  /** Default routing target for unqualified `social.*` calls. Keyed into `providers`. */
  default: string
  providers: Record<string, ProviderConfig>
}

export interface ProviderConfig {
  /** Driver identifier — must match a built-in (`'line'` / `'google'` / `'facebook'`) or a name registered via `manager.extend(name, factory)`. */
  driver: string
  /** Driver-specific fields — see each adapter's `*Config`. */
  [key: string]: unknown
}
