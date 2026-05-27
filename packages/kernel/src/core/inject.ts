/**
 * `@inject()` marks a class as injectable. The container reads constructor
 * param types via `reflect-metadata` (TypeScript's `emitDecoratorMetadata`)
 * and recursively resolves them.
 *
 * @example
 * ```ts
 * @inject()
 * class UserService {
 *   constructor(private db: Database, private cache: Cache) {}
 * }
 *
 * app.singleton(UserService)        // or just call app.make(UserService)
 * ```
 *
 * **Circular deps are not supported.** If class A lists class B as a constructor
 * param and B is declared after A, the decorator call hits JavaScript's temporal
 * dead zone and throws `ReferenceError`. Restructure: extract a common abstraction
 * or move shared state into a dedicated service.
 */

import 'reflect-metadata'

import type { Constructor } from './types.ts'

/** Symbol attached to classes marked with `@inject()`. */
export const INJECTABLE = Symbol.for('@strav/kernel/INJECTABLE')

/**
 * Class decorator that marks a class as injectable.
 *
 * Constructor params must be classes (not primitives, not interfaces) — TypeScript
 * emits the runtime metadata only for class references. For non-class deps, use
 * a string-keyed binding and resolve manually in a factory.
 */
export function inject(): ClassDecorator {
  return (target: object) => {
    Object.defineProperty(target, INJECTABLE, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    })
  }
}

/** Is this class marked with `@inject()`? */
export function isInjectable(cls: unknown): boolean {
  if (typeof cls !== 'function') return false
  return (cls as unknown as Record<symbol, unknown>)[INJECTABLE] === true
}

/**
 * Read the constructor param types of an `@inject()`-marked class.
 * Returns an empty array if the class has no constructor params.
 */
export function getParamTypes(cls: Constructor): Constructor[] {
  return (Reflect.getMetadata('design:paramtypes', cls) as Constructor[] | undefined) ?? []
}
