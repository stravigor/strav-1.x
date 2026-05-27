/**
 * `AuthProvider` — wires authentication into the application container.
 *
 * Bindings:
 *   - `Hasher` (singleton)
 *   - `SessionRepository` (singleton; resolved via `@inject()` against PostgresDatabase)
 *   - `AuthManager` (singleton; built from `config.auth.default`)
 *   - The `auth` / `guest` middleware on `MiddlewareRegistry` (auto-registered)
 *
 * The provider's `boot()`:
 *   - Reads `config.auth.guards` and registers each guard with the manager.
 *     Built-in drivers: `memory`, `session`. (`token` lands with the next
 *     auth slice.) Custom guards register themselves in their own provider.
 *   - Installs an HTTP context enricher that attaches `ctx.auth` to every
 *     request.
 *
 * Depends on `'http'` for the kernel + MiddlewareRegistry. `session` driver
 * use depends on `'database'` being booted first (the SessionRepository
 * needs `PostgresDatabase`); apps using session guards must list it in
 * `useProviders([…DatabaseProvider, AuthProvider])`.
 */

import { HttpKernel, MiddlewareRegistry } from '@strav/http'
import { type Application, ConfigError, ConfigRepository, ServiceProvider } from '@strav/kernel'

// Side-effect import — installs the HttpContext.auth augmentation so the
// enricher below typechecks against the widened ctx.
import './context_augmentation.ts'
import { AuthContext } from './auth_context.ts'
import { AuthManager } from './auth_manager.ts'
import type { Authenticatable } from './authenticatable.ts'
import type { Guard } from './guard.ts'
import { Hasher, type HasherOptions } from './hasher.ts'
import { authMiddleware } from './middleware/auth_middleware.ts'
import { guestMiddleware } from './middleware/guest_middleware.ts'
import { AUTH_BUILTIN_NAMES } from './middleware/index.ts'
import { SessionGuard } from './session/session_guard.ts'
import { SessionRepository } from './session/session_repository.ts'

export interface AuthConfigShape {
  /** Default guard name; matches a key in `guards`. */
  default: string
  /** Map of guard-name → driver descriptor. */
  guards: Record<string, GuardConfigEntry>
  /** Hasher cost parameters. */
  hasher?: HasherOptions
}

export type GuardConfigEntry =
  | {
      /**
       * Reference to a custom guard the app registered on the container
       * (e.g., via its own provider). The provider name is resolved via
       * `app.resolve<Guard>(name)` — strings only.
       */
      driver: 'custom'
      service: string
    }
  | {
      /**
       * DB-backed session guard. Reads/writes session rows via
       * `SessionRepository`; the user is loaded via a container binding
       * the app has already registered (typically `UserRepository`).
       *
       * The app's `UserRepository` (or whatever binding) must expose
       * `find(id)` — every `@strav/database` Repository does by default.
       */
      driver: 'session'
      /** Container binding key the user loader is registered under. */
      userResolverService: string
      /** Cookie name. Default `'strav_session'`. */
      cookieName?: string
      /** Session lifetime in seconds. Default 14 days. */
      ttlSeconds?: number
      /** HTTPS-only cookie. Default true. Flip to false for local HTTP dev. */
      secure?: boolean
    }
// Future: 'token' | 'jwt' driver descriptors land with their respective slices.

export class AuthProvider extends ServiceProvider {
  override readonly name = 'auth'
  override readonly dependencies = ['config', 'http']

  override register(app: Application): void {
    app.singleton(Hasher, (c) => {
      const config = c.resolve(ConfigRepository).get('auth') as AuthConfigShape | undefined
      return new Hasher(config?.hasher ?? {})
    })

    // SessionRepository is `@inject()`-marked; the container resolves
    // its PostgresDatabase constructor param automatically. Bound here
    // so a) apps using `driver: 'session'` get it for free, and b) apps
    // not using sessions don't pay for it (lazy resolution).
    app.singleton(SessionRepository)

    app.singleton(AuthManager, (c) => {
      const config = c.resolve(ConfigRepository).get('auth') as AuthConfigShape | undefined
      if (!config) {
        throw new ConfigError(
          'AuthProvider: `config.auth` is missing. Add a `config/auth.ts` file (see docs/auth/guides/setup.md).',
        )
      }
      const manager = new AuthManager(config.default)
      this.registerGuards(app, manager, config)
      return manager
    })

    // Built-in middleware — registered as factories so `auth:guardName` works.
    const reg = app.resolve(MiddlewareRegistry)
    if (!reg.has(AUTH_BUILTIN_NAMES.auth)) {
      reg.register(
        AUTH_BUILTIN_NAMES.auth,
        (guard?: string) => authMiddleware(guard ? { guard } : {}),
        { factory: true },
      )
    }
    if (!reg.has(AUTH_BUILTIN_NAMES.guest)) {
      reg.register(
        AUTH_BUILTIN_NAMES.guest,
        (guard?: string) => guestMiddleware(guard ? { guard } : {}),
        { factory: true },
      )
    }
  }

  override boot(app: Application): void {
    // Eagerly resolve the manager so config errors surface at boot.
    const manager = app.resolve(AuthManager)

    // Wire `ctx.auth` for every request. Runs before any middleware so
    // `auth`/`guest` middleware + handlers can read `ctx.auth.user` directly.
    app.resolve(HttpKernel).addContextEnricher((ctx) => {
      ctx.auth = new AuthContext(ctx, manager)
    })
  }

  /**
   * Walk `config.auth.guards` and register each entry on the manager.
   * Custom guards must already be bound on the container under the supplied
   * service name — the provider doesn't construct them.
   */
  private registerGuards(app: Application, manager: AuthManager, config: AuthConfigShape): void {
    for (const [name, entry] of Object.entries(config.guards)) {
      const guard = this.resolveGuard(app, name, entry)
      if (guard.name !== name) {
        throw new ConfigError(
          `AuthProvider: guard at config.auth.guards.${name} declares name "${guard.name}" — names must match the config key.`,
        )
      }
      manager.register(guard)
    }
    if (!manager.list().some((g) => g.name === config.default)) {
      throw new ConfigError(
        `AuthProvider: default guard "${config.default}" is not declared in config.auth.guards.`,
      )
    }
  }

  private resolveGuard(
    app: Application,
    name: string,
    entry: GuardConfigEntry,
  ): Guard<Authenticatable> {
    if (entry.driver === 'custom') {
      return app.resolve<Guard<Authenticatable>>(entry.service)
    }
    if (entry.driver === 'session') {
      const sessions = app.resolve(SessionRepository)
      const userResolver = this.buildUserResolver(app, name, entry.userResolverService)
      return new SessionGuard({
        name,
        cookieName: entry.cookieName,
        ttlSeconds: entry.ttlSeconds,
        secure: entry.secure,
        sessions,
        userResolver,
      })
    }
    // Future: 'token' / 'jwt'. Today's exhaustive check surfaces typos loud.
    throw new ConfigError(
      `AuthProvider: guard "${name}" uses driver "${(entry as { driver: string }).driver}" which is not implemented yet. ` +
        `Register a custom guard on the container and use { driver: 'custom', service: '<name>' }.`,
    )
  }

  /**
   * Adapt an app-registered "user finder" service into the `(id) => user`
   * function the SessionGuard expects. Accepts any object with a `find(id)`
   * method — every `@strav/database` Repository has one — so apps typically
   * point at their UserRepository binding directly.
   */
  private buildUserResolver(
    app: Application,
    guardName: string,
    serviceKey: string,
  ): (id: string) => Promise<Authenticatable | null> | Authenticatable | null {
    const service = app.resolve<{ find?: unknown }>(serviceKey)
    if (typeof service?.find !== 'function') {
      throw new ConfigError(
        `AuthProvider: guard "${guardName}" — service "${serviceKey}" does not expose a \`find(id)\` method. ` +
          'Point `userResolverService` at a Repository (or any object with `find(id) → user | null`).',
      )
    }
    const find = service.find.bind(service) as (
      id: string,
    ) => Promise<Authenticatable | null> | Authenticatable | null
    return (id: string) => find(id)
  }
}
