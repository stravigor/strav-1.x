/**
 * `MiddlewareRegistry` — maps the string names routes use
 * (`router.middleware('auth')`, `router.middleware('throttle:60,1m')`)
 * to the underlying `MiddlewareDef`.
 *
 * The kernel resolves names to defs at route compile time, *not* per
 * request. Unknown names throw `ConfigError` so a typo in `routes/*.ts`
 * surfaces at boot rather than the first request.
 *
 * Parameterized middleware (`throttle:60,1m`) uses the substring before `:`
 * as the registry key; the substring after is passed to a parameterizing
 * factory when the registered def is a factory function.
 */

import { ConfigError } from '@strav/kernel'
import type { MiddlewareDef } from './types.ts'

export type MiddlewareFactory = (...args: string[]) => MiddlewareDef
export type MiddlewareEntry = MiddlewareDef | MiddlewareFactory

export class MiddlewareRegistry {
  private readonly entries = new Map<string, MiddlewareEntry>()
  /** Names whose entry is a factory — needs argument parsing on resolve. */
  private readonly factories = new Set<string>()

  /** Register a middleware under one name. Throws on duplicate. */
  register(name: string, entry: MiddlewareEntry, options: { factory?: boolean } = {}): this {
    if (this.entries.has(name)) {
      throw new ConfigError(`MiddlewareRegistry: "${name}" is already registered.`)
    }
    this.entries.set(name, entry)
    if (options.factory) this.factories.add(name)
    return this
  }

  /** True when `name` (or its `name:args` prefix) is registered. */
  has(reference: string): boolean {
    const key = reference.split(':')[0] ?? ''
    return this.entries.has(key)
  }

  /**
   * Resolve a route-level middleware reference. `reference` may be a plain
   * name (`'auth'`) or a parameterized form (`'throttle:60,1m'`); the latter
   * only works when the entry was registered as `{ factory: true }`.
   */
  resolve(reference: string): MiddlewareDef {
    const [name, rawArgs] = splitOnce(reference, ':')
    const entry = this.entries.get(name)
    if (!entry) {
      throw new ConfigError(`MiddlewareRegistry: no middleware registered under "${name}".`)
    }
    if (this.factories.has(name)) {
      const args = rawArgs ? rawArgs.split(',').map((s) => s.trim()) : []
      return (entry as MiddlewareFactory)(...args)
    }
    if (rawArgs !== undefined) {
      throw new ConfigError(
        `MiddlewareRegistry: "${name}" is not a factory; "${reference}" passes args.`,
      )
    }
    return entry as MiddlewareDef
  }
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const idx = value.indexOf(sep)
  if (idx === -1) return [value, undefined]
  return [value.slice(0, idx), value.slice(idx + 1)]
}
