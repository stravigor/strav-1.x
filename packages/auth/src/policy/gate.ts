/**
 * `Gate` — the central registry for policies and ability functions.
 *
 * Two kinds of authorization:
 *
 * 1. **Policies** — class-based, resource-scoped:
 *      `gate.policy(Lead, LeadPolicy)`
 *      `ctx.auth.authorize('update', lead)` → calls `LeadPolicy.update(user, lead)`
 *
 * 2. **Gates** (function-style abilities) — standalone, not tied to a resource:
 *      `gate.define('admin.access', (user) => user.role === 'admin')`
 *      `ctx.auth.can('admin.access')` → calls the ability function
 *
 * `authorize(ability, ...args)` throws `AuthorizationError` on denial so
 * controllers stay clean:
 *   ```ts
 *   ctx.auth.authorize('update', lead)   // throws on deny; clean on allow
 *   ```
 *
 * `can(ability, ...args)` returns a boolean — no throw.
 * `cannot(ability, ...args)` is the inverse.
 */

import { StravError } from '@strav/kernel'
import type { Authenticatable } from '../authenticatable.ts'

export class AuthorizationError extends StravError {
  constructor(message = 'Not authorized.', options: { context?: Record<string, unknown> } = {}) {
    super(message, { code: 'auth.unauthorized', status: 403 }, options)
  }
}

// A policy method returns boolean (allowed/denied) or throws `AuthorizationError`
// with a custom message/code.
export type PolicyMethod = (user: Authenticatable, ...args: unknown[]) => boolean | Promise<boolean>

export type PolicyClass = new (...args: any[]) => any

// A gate ability is a standalone function (no resource argument required,
// but apps can pass extra context).
export type AbilityFn = (user: Authenticatable, ...args: unknown[]) => boolean | Promise<boolean>

export type ResourceLoader = (id: string) => Promise<unknown>

export class Gate {
  // constructor → policy class
  private readonly policies = new Map<new (...args: any[]) => any, PolicyClass>()
  // ability name → ability function
  private readonly abilities = new Map<string, AbilityFn>()
  // resource key → loader (used by `policy:leads,update` middleware)
  private readonly resourceLoaders = new Map<string, ResourceLoader>()

  /**
   * Register a loader for the `policy:resource,ability` middleware.
   *   `gate.resource('leads', (id) => leadRepo.find(id))`
   * The loader receives the `:id` param from the route and should return
   * the loaded resource or `null` (→ 404).
   */
  resource(key: string, loader: ResourceLoader): this {
    this.resourceLoaders.set(key, loader)
    return this
  }

  /** Internal: load a resource by key + id for the policy middleware. */
  async loadResource(key: string, id: string): Promise<unknown> {
    const loader = this.resourceLoaders.get(key)
    if (!loader) {
      throw new AuthorizationError(
        `Gate: no resource loader registered for "${key}". Call gate.resource("${key}", loader) in your provider.`,
      )
    }
    return loader(id)
  }

  /**
   * Register a policy class for a resource class.
   *   `gate.policy(Lead, LeadPolicy)`
   */
  policy<T>(resourceClass: new (...args: any[]) => T, policyClass: PolicyClass): this {
    this.policies.set(resourceClass as new (...args: any[]) => any, policyClass)
    return this
  }

  /**
   * Register a standalone ability function.
   *   `gate.define('admin.access', (user) => user.role === 'admin')`
   */
  define(ability: string, fn: AbilityFn): this {
    this.abilities.set(ability, fn)
    return this
  }

  /**
   * Evaluate `ability` for `user`. Throws `AuthorizationError` on denial.
   *
   * When the first extra arg is an object, its constructor is used to look
   * up the registered policy. The `ability` string is the method name on
   * that policy (e.g. `'update'`). If no policy is found, falls back to a
   * registered gate ability. If neither exists, throws.
   */
  async authorize(
    ability: string,
    user: Authenticatable | null | undefined,
    ...args: unknown[]
  ): Promise<void> {
    if (!user) throw new AuthorizationError()
    const allowed = await this.evaluate(ability, user, ...args)
    if (!allowed) throw new AuthorizationError()
  }

  /** Boolean check — no throw. */
  async can(
    ability: string,
    user: Authenticatable | null | undefined,
    ...args: unknown[]
  ): Promise<boolean> {
    if (!user) return false
    try {
      return await this.evaluate(ability, user, ...args)
    } catch (err) {
      if (err instanceof AuthorizationError) return false
      throw err
    }
  }

  /** Inverse of `can`. */
  async cannot(
    ability: string,
    user: Authenticatable | null | undefined,
    ...args: unknown[]
  ): Promise<boolean> {
    return !(await this.can(ability, user, ...args))
  }

  /** Internal: evaluate without throwing on denial (throws only on missing ability/policy). */
  private async evaluate(
    ability: string,
    user: Authenticatable,
    ...args: unknown[]
  ): Promise<boolean> {
    // Policy lookup: if the first arg is an object, try its constructor.
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      const resourceClass = (args[0] as object).constructor as new (...a: any[]) => any
      const PolicyCls = this.policies.get(resourceClass)
      if (PolicyCls) {
        const policyInstance = new PolicyCls()
        const method = policyInstance[ability]
        if (typeof method !== 'function') {
          throw new AuthorizationError(
            `Policy ${PolicyCls.name} does not define ability "${ability}".`,
          )
        }
        return Boolean(await method.call(policyInstance, user, ...args))
      }
    }

    // Gate ability fallback.
    const fn = this.abilities.get(ability)
    if (fn) {
      return Boolean(await fn(user, ...args))
    }

    throw new AuthorizationError(
      `No policy or gate found for ability "${ability}". Register it with gate.policy() or gate.define().`,
    )
  }
}
