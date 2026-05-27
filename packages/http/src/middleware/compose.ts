/**
 * `composeMiddleware` — build a runnable onion from a list of middleware
 * definitions plus the final handler.
 *
 * Per-request: class middleware is instantiated via `scope.make(Class)`. The
 * resulting instance is recorded so the kernel can call `terminate(ctx, res)`
 * on instances that implement it, *after* the response is sent.
 *
 * Caller must call `chain.invoke(ctx)`; once that resolves, `chain.
 * terminatingInstances()` returns the list to terminate.
 */

import type { Container } from '@strav/kernel'
import type { HttpContext } from '../context/types.ts'
import type {
  ComposedChain,
  MiddlewareClass,
  MiddlewareDef,
  MiddlewareFn,
  NextFn,
} from './types.ts'

/** Final handler — what runs after every middleware's `next()`. */
export type FinalHandler = (ctx: HttpContext) => Response | Promise<Response>

export function composeMiddleware(
  middleware: readonly MiddlewareDef[],
  finalHandler: FinalHandler,
  scope: Container,
): ComposedChain {
  const terminating: MiddlewareClass[] = []

  const resolved: MiddlewareFn[] = middleware.map((def) => toFn(def, scope, terminating))

  const invoke = (ctx: HttpContext): Promise<Response> => {
    return dispatch(0, ctx)

    async function dispatch(i: number, ctx: HttpContext): Promise<Response> {
      if (i === resolved.length) {
        return Promise.resolve(finalHandler(ctx))
      }
      const next: NextFn = () => dispatch(i + 1, ctx)
      // biome-ignore lint/style/noNonNullAssertion: i bounded above
      return Promise.resolve(resolved[i]!(ctx, next))
    }
  }

  return {
    invoke,
    terminatingInstances: () => terminating,
  }
}

function toFn(def: MiddlewareDef, scope: Container, terminating: MiddlewareClass[]): MiddlewareFn {
  if (typeof def === 'function' && !isConstructor(def)) {
    return def as MiddlewareFn
  }
  const Class = def as new () => MiddlewareClass
  // Instantiated lazily: building the chain shouldn't trigger constructor
  // side-effects when a short-circuit earlier in the chain means this
  // middleware never runs. We instantiate on first call only.
  let instance: MiddlewareClass | undefined
  return (ctx, next) => {
    if (!instance) {
      instance = scope.make(Class)
      if (typeof instance.terminate === 'function') {
        terminating.push(instance)
      }
    }
    return instance.handle(ctx, next)
  }
}

/**
 * Heuristic: a function with a non-empty `prototype` is treated as a class
 * constructor. ES class declarations always have a `prototype`; arrow
 * functions do not. Plain `function fn(){}` declarations do, but we expect
 * apps to write `(ctx, next) => …` for function middleware — the standard
 * `compose` convention.
 */
function isConstructor(value: unknown): boolean {
  if (typeof value !== 'function') return false
  // ES class detection — class declarations stringify with the `class` keyword.
  return /^\s*class\b/.test(Function.prototype.toString.call(value))
}
