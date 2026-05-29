/**
 * Type contracts for `defineMachine(...)`. Apps don't typically import
 * these directly — they fall out of the generics on `Machine<TEntity,
 * TState, TTransition>`. They're exported so library code that holds
 * machines generically can still type-narrow.
 *
 * `field` is the property name on the entity that holds the state value.
 * The machine reads + mutates it via `entity[field]`. Convention is a
 * snake_case column name (`status`, `state`, `workflow_phase`), but
 * anything that lives on the entity works.
 */

/** A single transition: which state(s) can `from`, and which state lands as `to`. */
export interface TransitionDefinition<TState extends string = string> {
  /** Source state, or a list of source states. */
  from: TState | readonly TState[]
  /** Destination state. */
  to: TState
}

/** What a guard / effect / `transition()` callback receives. */
export interface TransitionMeta<
  TState extends string = string,
  TTransition extends string = string,
> {
  readonly from: TState
  readonly to: TState
  readonly transition: TTransition
}

/**
 * Full machine definition — the input to `defineMachine(...)`.
 *
 * `guards`, `effects`, and `events` are all keyed on transition names.
 * Each is optional — a machine with no guards/effects/events is valid
 * and useful (pure transition validation).
 */
export interface MachineDefinition<
  TEntity extends object = object,
  TState extends string = string,
  TTransition extends string = string,
> {
  /** Property name on the entity that holds the state. */
  field: string
  /** Initial state for newly-created entities — apps that want to reuse it. */
  initial: TState
  /** All valid state values — used as a validation reference and a published surface. */
  states: readonly TState[]
  /** Named transitions with `from` (one or many) + `to`. */
  transitions: Record<TTransition, TransitionDefinition<TState>>
  /**
   * Guards run AFTER the state-validity check but BEFORE the mutation.
   * Return `false` (sync or async) to block the transition with
   * `GuardError`. Throwing also blocks; the throw propagates verbatim.
   */
  guards?: Partial<
    Record<TTransition, (entity: TEntity) => boolean | Promise<boolean>>
  >
  /**
   * Effects run AFTER the entity field is mutated. Use them for
   * in-process side work that needs to see the new state on the
   * entity (`order.status === 'shipped'`). For external side effects
   * that must be transactional with the save, dispatch a Job from the
   * effect — `@strav/queue` queues until the surrounding tx commits.
   */
  effects?: Partial<
    Record<
      TTransition,
      (
        entity: TEntity,
        meta: TransitionMeta<TState, TTransition>,
      ) => void | Promise<void>
    >
  >
  /**
   * Optional event-bus names emitted on successful transitions. Only
   * fires when the transition is applied via the `stateful(...)`
   * Repository mixin (which has access to the Repository's EventBus).
   * Standalone `machine.apply(entity, name)` skips emission — it has
   * no EventBus to call.
   */
  events?: Partial<Record<TTransition, string>>
}
