/**
 * `defineMachine(...)` — build a `Machine` from a declarative definition.
 *
 * The returned object is a pure (no DI, no DB, no event bus) value: the
 * same machine works for an in-memory POJO, a Repository-managed row,
 * or a request DTO. Persistence and event emission are layered on top
 * via the `stateful(...)` Repository mixin.
 *
 * The `field` and `transitions` are required; `guards`, `effects`, and
 * `events` are optional. A machine with no guards/effects/events is a
 * pure transition validator — still useful for `can()` / `availableTransitions()`.
 *
 * Example:
 *
 * ```ts
 * type OrderState      = 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
 * type OrderTransition = 'process' | 'ship' | 'deliver' | 'cancel'
 *
 * export const orderMachine = defineMachine<Order, OrderState, OrderTransition>({
 *   field: 'status',
 *   initial: 'pending',
 *   states: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
 *   transitions: {
 *     process: { from: 'pending',                    to: 'processing' },
 *     ship:    { from: 'processing',                 to: 'shipped'    },
 *     deliver: { from: 'shipped',                    to: 'delivered'  },
 *     cancel:  { from: ['pending', 'processing'],    to: 'cancelled'  },
 *   },
 *   guards:  { cancel: (order) => !order.locked },
 *   effects: { ship:   async (order) => sendShippingNotification(order) },
 *   events:  { ship:   'order.shipped' },
 * })
 * ```
 */

import { GuardError } from './guard_error.ts'
import type { Machine } from './machine.ts'
import type {
  MachineDefinition,
  TransitionMeta,
} from './machine_definition.ts'
import { TransitionError } from './transition_error.ts'

export function defineMachine<
  TEntity extends object,
  TState extends string,
  TTransition extends string,
>(
  definition: MachineDefinition<TEntity, TState, TTransition>,
): Machine<TEntity, TState, TTransition> {
  // Pre-compute the `from` array for each transition so `can()` and
  // `availableTransitions()` don't re-normalize on every call.
  const fromMap = new Map<TTransition, readonly TState[]>()
  for (const [name, def] of Object.entries(definition.transitions) as Array<
    [TTransition, TransitionDef<TState>]
  >) {
    fromMap.set(name, Array.isArray(def.from) ? def.from : [def.from])
  }

  const readField = (entity: TEntity): TState =>
    (entity as Record<string, unknown>)[definition.field] as TState

  return {
    definition,

    state: readField,

    is: (entity, state) => readField(entity) === state,

    can(entity, transition) {
      const allowed = fromMap.get(transition)
      if (!allowed) return false
      const current = readField(entity)
      if (!allowed.includes(current)) return false
      const guard = definition.guards?.[transition]
      if (!guard) return true
      const result = guard(entity)
      // Preserve sync vs async — apps that want a boolean today
      // shouldn't be forced into a Promise when no guard is async.
      if (result instanceof Promise) return result
      return result
    },

    availableTransitions(entity) {
      const current = readField(entity)
      const available: TTransition[] = []
      for (const [name, allowed] of fromMap) {
        if (allowed.includes(current)) available.push(name)
      }
      return available
    },

    async apply(entity, transition) {
      const def = definition.transitions[transition]
      const current = readField(entity)
      if (!def) {
        throw new TransitionError(transition, current)
      }
      const allowed = fromMap.get(transition) ?? []
      if (!allowed.includes(current)) {
        throw new TransitionError(transition, current, allowed)
      }
      const guard = definition.guards?.[transition]
      if (guard) {
        const passed = await guard(entity)
        if (!passed) {
          throw new GuardError(transition, current)
        }
      }

      const meta: TransitionMeta<TState, TTransition> = {
        from: current,
        to: def.to,
        transition,
      }

      // Mutate first so any effect sees the new state on the entity.
      // Cast through `unknown` because `TState` is more specific than
      // `unknown` and `Record<string, unknown>` widens to it.
      ;(entity as Record<string, unknown>)[definition.field] = def.to

      const effect = definition.effects?.[transition]
      if (effect) {
        await effect(entity, meta)
      }

      return meta
    },
  }
}

// Narrow alias for the inner-loop type assertion above; not exported.
interface TransitionDef<TState extends string> {
  from: TState | readonly TState[]
  to: TState
}
