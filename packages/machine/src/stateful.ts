/**
 * `stateful(Base, machine)` — class-mixin that bolts state-machine
 * methods onto a `Repository` subclass.
 *
 * The mixin adds four instance methods that delegate to the machine:
 *   - `is(entity, state)`             — boolean equality on the state field
 *   - `can(entity, transition)`       — eligibility check (incl. guard)
 *   - `availableTransitions(entity)`  — transitions valid from current state
 *   - `transition(entity, name)`      — validate + mutate + effect + save + emit
 *
 * `transition()` is the load-bearing method: it runs the machine, persists
 * the field change via `Repository.update`, and (when the machine
 * defines an `events.<name>` entry AND the repo was constructed with an
 * EventBus) emits the event with `{ entity, ...meta }` as the payload.
 *
 * Mixins compose: a Repository can stack `stateful(...)` and any other
 * mixin via plain class inheritance. The returned class stays abstract
 * (still needs `static schema = …` + `static model = …` from the
 * concrete subclass) — the mixin doesn't try to know which schema you're on.
 *
 * Example:
 *
 * ```ts
 * @inject()
 * class OrderRepository extends stateful(Repository<Order>, orderMachine) {
 *   static override readonly schema = orderSchema
 *   static override readonly model = Order
 *   // (No explicit constructor needed — Repository's options-bag form is inherited.)
 * }
 *
 * const order = await orderRepo.find('o1')
 * await orderRepo.transition(order, 'ship')
 * ```
 */

import { Repository } from '@strav/database'
import type { Machine } from './machine.ts'
import type { TransitionMeta } from './machine_definition.ts'

/**
 * Constructor type for an abstract Repository subclass — matches the
 * shape `class extends Repository<T>` produces. Using `abstract new`
 * lets the mixin accept `Repository` itself (which is abstract).
 */
// biome-ignore lint/suspicious/noExplicitAny: mixin constructor signature requires variadic any[]
export type RepositoryConstructor<TEntity extends object> = abstract new (
  // biome-ignore lint/suspicious/noExplicitAny: see above
  ...args: any[]
) => Repository<TEntity>

export function stateful<
  TBase extends RepositoryConstructor<TEntity>,
  TEntity extends object,
  TState extends string,
  TTransition extends string,
>(Base: TBase, machine: Machine<TEntity, TState, TTransition>) {
  abstract class Stateful extends Base {
    /** Boolean equality on the configured state field. Pure delegate to the machine. */
    is(entity: TEntity, state: TState): boolean {
      return machine.is(entity, state)
    }

    /** Eligibility check. Returns a sync boolean unless the registered guard is async. */
    can(entity: TEntity, transition: TTransition): boolean | Promise<boolean> {
      return machine.can(entity, transition)
    }

    /** Names of every transition currently valid from the entity's state. */
    availableTransitions(entity: TEntity): TTransition[] {
      return machine.availableTransitions(entity)
    }

    /**
     * Apply a transition end-to-end:
     *   1. Validate the move + run the guard via `machine.apply()`.
     *      Mutates `entity[field]` in-place.
     *   2. Run the per-transition `effect` (if any). Effects see the
     *      new state.
     *   3. Persist by calling `Repository.update(entity, { [field]: to })`.
     *      The change propagates through lifecycle events
     *      (`<resource>.updating` / `<resource>.updated`) just like any
     *      other update — listeners that care about the state column
     *      can read the change off the model.
     *   4. Emit the machine-defined event (when both
     *      `machine.events[name]` and the Repository's `EventBus` are
     *      present). Payload is `{ entity, ...meta }`.
     *
     * Throws `TransitionError` / `GuardError` from step 1. Effects and
     * `update()` errors propagate verbatim — in those cases the entity
     * may already be mutated in-memory but the row hasn't been written.
     * Callers that need atomicity wrap the call in `UnitOfWork.run(...)`
     * or `TenantManager.withTenant(...)`.
     */
    async transition(
      entity: TEntity,
      name: TTransition,
    ): Promise<TransitionMeta<TState, TTransition>> {
      const meta = await machine.apply(entity, name)
      const field = machine.definition.field
      // `Partial<TEntity>` requires the field key + value to type-narrow
      // against the entity's actual shape; we widen via Record<string, unknown>
      // because the mixin doesn't know the entity's exact key set.
      await this.update(entity, { [field]: meta.to } as unknown as Partial<TEntity>)

      const eventName = machine.definition.events?.[name]
      if (eventName && this.events) {
        await this.events.emit(eventName, { entity, ...meta })
      }

      return meta
    }
  }

  return Stateful
}
