/**
 * `policy` middleware factory — sugar for resource-level authorization.
 *
 * Usage on a route: `.middleware('policy:leads,update')`
 *
 * On invocation:
 *   1. Looks up the loader registered via `gate.resource('leads', loader)`.
 *   2. Loads the resource by the route's `:id` param.
 *   3. Calls `ctx.auth.authorize('update', resource)`.
 *
 * If the resource is not found → 404.
 * If authorization fails → 403 (AuthorizationError).
 */

import type { MiddlewareFn } from '@strav/http'
import '../context_augmentation.ts'
import type { Gate } from './gate.ts'

export function makePolicyMiddleware(
  gate: Gate,
  resourceKey: string,
  ability: string,
): MiddlewareFn {
  return async (ctx, next) => {
    const id = (ctx.request.params as Record<string, string>).id
    if (!id) {
      throw new Error('policy middleware: no :id param on the route. Add :id to the route pattern.')
    }

    const resource = await gate.loadResource(resourceKey, id)
    if (resource === null) {
      return new Response('Not Found', { status: 404 })
    }

    if (!ctx.auth)
      throw new Error(
        'policy middleware: ctx.auth is missing. Add the auth middleware before policy.',
      )
    await ctx.auth.authorize(ability, resource)
    return next()
  }
}
