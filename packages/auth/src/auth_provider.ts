/**
 * `AuthProvider` — wires authentication into the application container.
 *
 * Bindings:
 *   - `Hasher` (singleton)
 *   - `SessionRepository` + `AccessTokenRepository` (singletons; resolved
 *     via `@inject()` against PostgresDatabase)
 *   - `AuthManager` (singleton; built from `config.auth.default`)
 *   - The `auth` / `guest` middleware on `MiddlewareRegistry` (auto-registered)
 *
 * The provider's `boot()`:
 *   - Reads `config.auth.guards` and registers each guard with the manager.
 *     Built-in drivers: `custom`, `session`, `token`. Custom guards
 *     register themselves in their own provider.
 *   - Installs an HTTP context enricher that attaches `ctx.auth` to every
 *     request.
 *
 * Depends on `'http'` for the kernel + MiddlewareRegistry. The `session`
 * and `token` drivers depend on `'database'` being booted first (their
 * Repositories need `PostgresDatabase`); apps using either must list
 * DatabaseProvider before AuthProvider in `useProviders([...])`.
 */

import { HttpKernel, MiddlewareRegistry } from '@strav/http'
import { type Application, ConfigError, ConfigRepository, ServiceProvider } from '@strav/kernel'

// Side-effect import — installs the HttpContext.auth augmentation so the
// enricher below typechecks against the widened ctx.
import './context_augmentation.ts'
import { PostgresDatabase } from '@strav/database'
import { AuthContext } from './auth_context.ts'
import { AuthManager } from './auth_manager.ts'
import type { Authenticatable } from './authenticatable.ts'
import type { Guard } from './guard.ts'
import { Hasher, type HasherOptions } from './hasher.ts'
import { MagicLinkManager } from './magic/magic_link_manager.ts'
import { authMiddleware } from './middleware/auth_middleware.ts'
import { guestMiddleware } from './middleware/guest_middleware.ts'
import { AUTH_BUILTIN_NAMES } from './middleware/index.ts'
import { Gate } from './policy/gate.ts'
import { makePolicyMiddleware } from './policy/policy_middleware.ts'
import { SessionGuard } from './session/session_guard.ts'
import { SessionRepository } from './session/session_repository.ts'
import { AccessTokenRepository } from './token/access_token_repository.ts'
import { TokenGuard } from './token/token_guard.ts'
import { EmailVerification } from './verification/email_verification.ts'
import { verifiedMiddleware } from './verification/verified_middleware.ts'

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
  | {
      /**
       * Bearer-token guard. Reads `Authorization: Bearer <token>` and
       * verifies via `AccessTokenRepository.findByPlaintext`. Tokens are
       * minted out-of-band (typically a token-management endpoint) by
       * calling `tokens.createToken(userId, name, opts?)`.
       */
      driver: 'token'
      /** Container binding key the user loader is registered under. */
      userResolverService: string
      /** Request header to read. Default `'authorization'`. */
      headerName?: string
      /** Scheme prefix. Default `'Bearer'`. Case-insensitive. */
      scheme?: string
    }
// Future: 'jwt' driver descriptor lands with its slice.

export class AuthProvider extends ServiceProvider {
  override readonly name = 'auth'
  override readonly dependencies = ['config', 'http']

  override register(app: Application): void {
    app.singleton(Hasher, (c) => {
      const config = c.resolve(ConfigRepository).get('auth') as AuthConfigShape | undefined
      return new Hasher(config?.hasher ?? {})
    })

    // SessionRepository + AccessTokenRepository are `@inject()`-marked;
    // the container resolves their PostgresDatabase constructor param
    // automatically. Bound here so apps using `driver: 'session' | 'token'`
    // get them for free; apps not using them don't pay (lazy resolution).
    app.singleton(SessionRepository)
    app.singleton(AccessTokenRepository)
    app.singleton(Gate)

    app.singleton(MagicLinkManager, (c) => {
      const config = c.resolve(ConfigRepository)
      const db = c.resolve(PostgresDatabase)
      const magicConfig = config.get('auth.magic') as
        | { baseUrl?: string; path?: string }
        | undefined
      return new MagicLinkManager({
        db,
        baseUrl: magicConfig?.baseUrl ?? (config.get('app.url') as string),
        path: magicConfig?.path,
      })
    })

    app.singleton(EmailVerification, (c) => {
      const config = c.resolve(ConfigRepository)
      const appKey = config.get('app.key') as string
      if (!appKey) {
        throw new ConfigError('EmailVerification: appKey is required. Set config.app.key.')
      }
      const verificationConfig = config.get('auth.verification') as
        | { baseUrl?: string; ttlSeconds?: number; path?: string }
        | undefined
      return new EmailVerification({
        appKey,
        baseUrl: verificationConfig?.baseUrl ?? (config.get('app.url') as string),
        ttlSeconds: verificationConfig?.ttlSeconds,
        path: verificationConfig?.path,
      })
    })

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
    if (!reg.has('policy')) {
      reg.register(
        'policy',
        (resourceKey?: string, ability?: string) => {
          if (!resourceKey || !ability) {
            throw new Error(
              'policy middleware: expected "policy:resource,ability" format (e.g. "policy:leads,update").',
            )
          }
          const gate = app.resolve(Gate)
          return makePolicyMiddleware(gate, resourceKey, ability)
        },
        { factory: true },
      )
    }
    if (!reg.has('verified')) {
      reg.register('verified', verifiedMiddleware())
    }
  }

  override boot(app: Application): void {
    // Eagerly resolve the manager so config errors surface at boot.
    const manager = app.resolve(AuthManager)

    // Wire `ctx.auth` for every request. Runs before any middleware so
    // `auth`/`guest` middleware + handlers can read `ctx.auth.user` directly.
    app.resolve(HttpKernel).addContextEnricher((ctx) => {
      const auth = new AuthContext(ctx, manager)
      if (app.has(Gate)) {
        auth.gateRef = app.resolve(Gate)
      }
      ctx.auth = auth
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
    if (entry.driver === 'token') {
      const tokens = app.resolve(AccessTokenRepository)
      const userResolver = this.buildUserResolver(app, name, entry.userResolverService)
      return new TokenGuard({
        name,
        headerName: entry.headerName,
        scheme: entry.scheme,
        tokens,
        userResolver,
      })
    }
    // Future: 'jwt'. Today's exhaustive check surfaces typos loud.
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
