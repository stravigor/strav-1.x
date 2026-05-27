/**
 * Router public types — HTTP method set, handler shapes, route/group options.
 *
 * Handler shapes (in priority order):
 *   1. **Closure** — `(ctx) => Response | unknown | Promise<…>`. No DI needed.
 *   2. **Single-action class** — `Constructor<{ handle(ctx): … }>`. The kernel
 *      `make()`s the instance per-request and calls `.handle(ctx)`.
 *   3. **Tuple** — `[Class, methodName]`. The kernel `make()`s the instance per
 *      request and calls `instance[methodName](ctx)`. The method name is
 *      narrowed at compile time via `ActionMethodNamesOf<T>`.
 *   4. **FormRequest tuple** — `[Class, methodName, FormRequestSubclass]`. The
 *      kernel pre-runs `FormRequest.from(ctx)` (authorize → transform →
 *      validate → cache) and calls `instance[methodName](req, ctx)`.
 */

import type { Constructor } from '@strav/kernel'
import type { HttpContext } from '../context/types.ts'
import type { FormRequest } from '../requests/form_request.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD'

/** Closure handler. May return any value; the kernel coerces to a `Response`. */
export type ClosureHandler = (ctx: HttpContext) => unknown | Promise<unknown>

/** Constructor of a single-action controller — must expose a `handle(ctx)` method. */
export interface SingleActionClass<T = unknown> {
  new (...args: never[]): { handle(ctx: HttpContext): T | Promise<T> }
}

/**
 * Names of `T`'s methods compatible with the controller-action signature
 * `(ctx) => …`. Used to keep the second tuple element type-safe (typos fail
 * at compile time). The constraint uses `any` for the return type because
 * TS's contravariant parameter check rejects narrower concrete return types
 * (e.g. `Response`) when the constraint is a union involving Promise.
 */
export type ActionMethodNamesOf<T> = {
  // biome-ignore lint/suspicious/noExplicitAny: see note above
  [K in keyof T]: T[K] extends (ctx: HttpContext) => any ? K : never
}[keyof T] &
  string

/** Typed tuple form — `[UserController, 'show']`. */
export type ActionRef<T = unknown> = readonly [Constructor<T>, ActionMethodNamesOf<T>]

/**
 * Names of `T`'s methods callable with `(req, ctx)` — i.e., any callable
 * property. We can't constrain to "first arg is a FormRequest subclass"
 * without runtime type info, so this is a looser check than
 * `ActionMethodNamesOf<T>`. Typo-safety on the name is preserved.
 */
export type FormRequestActionMethodNamesOf<T> = {
  // biome-ignore lint/suspicious/noExplicitAny: see note above
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T] &
  string

/**
 * Tuple with a `FormRequest` pre-stage —
 * `[UserController, 'store', StoreUserRequest]`. The kernel runs
 * `FormRequest.from(ctx)` and calls `instance[methodName](req, ctx)`.
 */
export type FormRequestActionRef<T = unknown, R extends FormRequest = FormRequest> = readonly [
  Constructor<T>,
  FormRequestActionMethodNamesOf<T>,
  new (ctx: HttpContext) => R,
]

/** Anything the router accepts as the route action. */
export type RouteHandler<T = unknown> =
  | ClosureHandler
  | SingleActionClass
  | ActionRef<T>
  | FormRequestActionRef<T>

/** Options accepted by `router.group({ ... }, callback)`. */
export interface RouteGroupOptions {
  /** Path prefix prepended to every route in the group (e.g. `/api`). */
  prefix?: string
  /** Middleware names appended to every route in the group. */
  middleware?: string | readonly string[]
  /** Name prefix prepended to every route's `.name(...)` (e.g. `api.`). */
  name?: string
}

/**
 * Compiled-route representation handed back by `router.list()` and used by
 * the trie at boot. `pattern` is the fully-expanded path after group prefixes
 * are applied; `paramNames` is the ordered list of `:param` / `*param` names
 * captured by the path.
 */
export interface CompiledRoute {
  method: HttpMethod
  pattern: string
  paramNames: readonly string[]
  handler: RouteHandler
  middleware: readonly string[]
  name?: string
}
