// Internal types shared by the container, application, and providers.
// Re-exported from the package barrel only where they are part of the public API.

// biome-ignore lint/suspicious/noExplicitAny: a constructor's params can be anything
export type Constructor<T = unknown> = new (...args: any[]) => T

import type { Container } from './container.ts'

/**
 * A factory takes the resolving container and returns a service instance.
 * Factories may call back into `c.resolve(...)` / `c.make(...)` for lazy deps.
 */
export type Factory<T> = (c: Container) => T

/** A binding can be keyed by a class constructor or by a string name. */
export type Key<T = unknown> = string | Constructor<T>

/** How a binding is cached. */
export type BindingKind = 'factory' | 'singleton' | 'scoped'

/** Internal binding record kept in the container's factory map. */
export interface Binding<T = unknown> {
  factory: Factory<T>
  kind: BindingKind
}

/**
 * Contextual override: when resolving deps for `consumer`, substitute `dep` with `impl`.
 * Stored in a Map<consumer, Map<dep, impl>>.
 */
export type ContextualKey = Constructor

/** A function returned by `on()`/`once()`/`subscribe()` that, when called, unregisters. */
export type Unsubscribe = () => void
