/**
 * `@strav/instant` — runtime config shapes.
 *
 * `InstantConfig` is the `config.instant` shape apps declare in
 * `config/instant.ts`. Multi-provider by default (apps could run
 * one LINE bot for support, another for marketing). `providers`
 * is keyed by app-chosen instance name; each entry carries a
 * `driver` discriminator the framework resolves to a concrete
 * `InstantDriver`. Apps with a single provider just register one
 * entry.
 *
 * `ProviderConfig` is free-form so each adapter owns its own
 * config shape (`LineProviderConfig` etc.) without forcing the
 * core to know every vendor field.
 */

export interface InstantConfig {
  /** Key into `providers`. The default routing target for unqualified `instant.*` calls. */
  default: string
  providers: Record<string, ProviderConfig>
}

export interface ProviderConfig {
  /**
   * Driver identifier — must match a name registered via
   * `manager.extend(name, factory)` (typically by an adapter
   * ServiceProvider).
   */
  driver: string
  /** Driver-specific fields — see each adapter's `*Config`. */
  [key: string]: unknown
}
