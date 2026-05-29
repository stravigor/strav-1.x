/**
 * `Machine` — the runtime interface produced by `defineMachine(...)`.
 *
 * Methods operate on any entity object that has the configured `field`.
 * The interface is decoupled from `@strav/database` so apps can use
 * machines on POJOs, query result rows, request payloads, etc. The
 * `stateful(...)` mixin in `stateful.ts` is the convenience wrapper for
 * the common case ("apply a transition and save it through a
 * Repository, optionally emit").
 *
 * `apply()` mutates the entity in-place and returns the `TransitionMeta`
 * for the move. It does NOT persist — callers handle persistence
 * (the `stateful` mixin does it for you).
 */

import type {
  MachineDefinition,
  TransitionMeta,
} from './machine_definition.ts'

export interface Machine<
  TEntity extends object = object,
  TState extends string = string,
  TTransition extends string = string,
> {
  /** The raw definition passed to `defineMachine`. Exposed for reflection. */
  readonly definition: MachineDefinition<TEntity, TState, TTransition>

  /** Read the current state directly off the entity's configured field. */
  state(entity: TEntity): TState

  /** Boolean equality on the current state. */
  is(entity: TEntity, state: TState): boolean

  /**
   * `true` when (a) the transition is defined, (b) the entity's current
   * state is one of the `from` states, and (c) the guard (if any)
   * resolves to `true`. Falls through to a synchronous boolean when no
   * guard is registered; otherwise returns a `Promise<boolean>` matching
   * the guard's signature.
   */
  can(entity: TEntity, transition: TTransition): boolean | Promise<boolean>

  /** Names of every transition currently valid from the entity's state, ignoring guards. */
  availableTransitions(entity: TEntity): TTransition[]

  /**
   * Validate the transition + run the guard + mutate the field + run the
   * effect, in that order. Throws `TransitionError` for an undefined or
   * disallowed transition; `GuardError` when the guard returns `false`;
   * propagates any throw from guard or effect verbatim. Does **not**
   * persist or emit — the `stateful(...)` mixin does both.
   */
  apply(
    entity: TEntity,
    transition: TTransition,
  ): Promise<TransitionMeta<TState, TTransition>>
}
