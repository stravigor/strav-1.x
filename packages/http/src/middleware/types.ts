/**
 * Middleware types — onion model.
 *
 * Two acceptable shapes:
 *   1. **Function** — `(ctx, next) => Response | Promise<Response>`.
 *   2. **Class** — exposes `handle(ctx, next)` and optionally
 *      `terminate(ctx, response)`. The kernel `make()`s the instance per
 *      request so `@inject()` deps work.
 *
 * `next()` returns the response produced by the rest of the chain. A
 * middleware may short-circuit by returning a Response without calling
 * `next()`, or wrap the result after `next()` returns.
 */

import type { Constructor } from '@strav/kernel'
import type { HttpContext } from '../context/types.ts'

export type NextFn = () => Promise<Response>

export type MiddlewareFn = (ctx: HttpContext, next: NextFn) => Response | Promise<Response>

export interface MiddlewareClass {
  handle(ctx: HttpContext, next: NextFn): Response | Promise<Response>
  terminate?(ctx: HttpContext, response: Response): void | Promise<void>
}

/** Anything the router/kernel will accept as a middleware reference. */
export type MiddlewareDef = MiddlewareFn | Constructor<MiddlewareClass>

/** Output of `composeMiddleware`. */
export interface ComposedChain {
  /** Run the chain against `ctx`. */
  invoke(ctx: HttpContext): Promise<Response>
  /** Terminating instances collected during the run; only valid after `invoke()` resolves. */
  terminatingInstances(): readonly MiddlewareClass[]
}
