/**
 * `AuthManager` — registry of named guards. Built once at boot from
 * `config.auth`; resolves the right guard at request time.
 *
 * The default guard (`config.auth.default`) is what `ctx.auth` shortcuts to;
 * `ctx.auth.guard('api')` pulls a named guard.
 */

import { ConfigError } from '@strav/kernel'
import type { Authenticatable } from './authenticatable.ts'
import type { Guard } from './guard.ts'

export class AuthManager {
  private readonly guards = new Map<string, Guard<Authenticatable>>()

  constructor(private readonly defaultGuard: string) {}

  /** Register a guard under one name. Throws on duplicate. */
  register(guard: Guard<Authenticatable>): this {
    if (this.guards.has(guard.name)) {
      throw new ConfigError(`AuthManager: guard "${guard.name}" is already registered.`)
    }
    this.guards.set(guard.name, guard)
    return this
  }

  /** Replace an existing guard. Used in tests + framework overrides. */
  replace(guard: Guard<Authenticatable>): this {
    this.guards.set(guard.name, guard)
    return this
  }

  /** Resolve a guard by name. Throws if not registered. */
  guard(name?: string): Guard<Authenticatable> {
    const target = name ?? this.defaultGuard
    const guard = this.guards.get(target)
    if (!guard) {
      throw new ConfigError(`AuthManager: no guard registered under "${target}".`)
    }
    return guard
  }

  /** Name of the default guard (set in config). */
  get default(): string {
    return this.defaultGuard
  }

  /** Iteration helper for tests + diagnostics. */
  list(): readonly Guard<Authenticatable>[] {
    return [...this.guards.values()]
  }
}
