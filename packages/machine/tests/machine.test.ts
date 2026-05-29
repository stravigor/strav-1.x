/**
 * Tests for the pure `defineMachine(...)` API.
 *
 * Covers state inspection (`state` / `is` / `availableTransitions`),
 * the `can` eligibility check with sync + async guards, and the full
 * `apply` lifecycle (mutate → effect → meta). Error paths exercise
 * undefined transitions, wrong-from-state, guard-rejected, and
 * effect-throwing.
 */

import { describe, expect, test } from 'bun:test'
import {
  defineMachine,
  GuardError,
  type MachineDefinition,
  TransitionError,
} from '../src/index.ts'

// ─── Fixture: an order machine ───────────────────────────────────────────

type OrderState =
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'

type OrderTransition = 'process' | 'ship' | 'deliver' | 'cancel'

interface Order {
  id: string
  status: OrderState
  locked?: boolean
}

const orderMachineDef: MachineDefinition<Order, OrderState, OrderTransition> = {
  field: 'status',
  initial: 'pending',
  states: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
  transitions: {
    process: { from: 'pending', to: 'processing' },
    ship: { from: 'processing', to: 'shipped' },
    deliver: { from: 'shipped', to: 'delivered' },
    cancel: { from: ['pending', 'processing'], to: 'cancelled' },
  },
  guards: {
    cancel: (order) => order.locked !== true,
  },
}

const orderMachine = defineMachine<Order, OrderState, OrderTransition>(orderMachineDef)

function makeOrder(overrides: Partial<Order> = {}): Order {
  return { id: 'o1', status: 'pending', ...overrides }
}

// ─── state / is / availableTransitions ────────────────────────────────────

describe('Machine — state inspection', () => {
  test('state() reads the configured field', () => {
    expect(orderMachine.state(makeOrder())).toBe('pending')
    expect(orderMachine.state(makeOrder({ status: 'shipped' }))).toBe('shipped')
  })

  test('is() is a boolean equality check', () => {
    expect(orderMachine.is(makeOrder({ status: 'pending' }), 'pending')).toBe(true)
    expect(orderMachine.is(makeOrder({ status: 'pending' }), 'shipped')).toBe(false)
  })

  test('availableTransitions() lists every transition with a matching from-state', () => {
    expect(orderMachine.availableTransitions(makeOrder({ status: 'pending' })).sort()).toEqual([
      'cancel',
      'process',
    ])
    expect(orderMachine.availableTransitions(makeOrder({ status: 'processing' })).sort()).toEqual([
      'cancel',
      'ship',
    ])
    expect(orderMachine.availableTransitions(makeOrder({ status: 'delivered' }))).toEqual([])
  })
})

// ─── can(): guards + state ───────────────────────────────────────────────

describe('Machine — can()', () => {
  test('returns false for a wrong-from-state move (no guard call)', () => {
    expect(orderMachine.can(makeOrder({ status: 'pending' }), 'ship')).toBe(false)
  })

  test('returns true when state matches + no guard registered', () => {
    expect(orderMachine.can(makeOrder({ status: 'pending' }), 'process')).toBe(true)
  })

  test('returns the guard verdict for a guarded transition', () => {
    // Unlocked → cancel allowed.
    expect(orderMachine.can(makeOrder({ status: 'pending' }), 'cancel')).toBe(true)
    // Locked → cancel blocked.
    expect(orderMachine.can(makeOrder({ status: 'pending', locked: true }), 'cancel')).toBe(false)
  })

  test('preserves async guards as Promise<boolean>', async () => {
    const asyncMachine = defineMachine<Order, OrderState, OrderTransition>({
      ...orderMachineDef,
      guards: {
        cancel: async (order) => !order.locked,
      },
    })
    const result = asyncMachine.can(makeOrder({ status: 'pending' }), 'cancel')
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toBe(true)
  })

  test('returns false for a transition not on the machine', () => {
    expect(orderMachine.can(makeOrder(), 'unknown' as OrderTransition)).toBe(false)
  })
})

// ─── apply(): mutate + effect + meta ──────────────────────────────────────

describe('Machine — apply()', () => {
  test('mutates the field and returns TransitionMeta', async () => {
    const order = makeOrder({ status: 'pending' })
    const meta = await orderMachine.apply(order, 'process')
    expect(order.status).toBe('processing')
    expect(meta).toEqual({ from: 'pending', to: 'processing', transition: 'process' })
  })

  test('runs the effect after mutation, with the new state visible', async () => {
    const seen: { status: OrderState; meta: { from: string; to: string } }[] = []
    const machine = defineMachine<Order, OrderState, OrderTransition>({
      ...orderMachineDef,
      effects: {
        ship: async (order, meta) => {
          seen.push({ status: order.status, meta: { from: meta.from, to: meta.to } })
        },
      },
    })
    const order = makeOrder({ status: 'processing' })
    await machine.apply(order, 'ship')
    expect(seen).toEqual([
      { status: 'shipped', meta: { from: 'processing', to: 'shipped' } },
    ])
  })

  test('honors `from` as an array of source states', async () => {
    const a = makeOrder({ status: 'pending' })
    await orderMachine.apply(a, 'cancel')
    expect(a.status).toBe('cancelled')

    const b = makeOrder({ status: 'processing' })
    await orderMachine.apply(b, 'cancel')
    expect(b.status).toBe('cancelled')
  })
})

// ─── apply() error paths ─────────────────────────────────────────────────

describe('Machine — apply() errors', () => {
  test('undefined transition → TransitionError (no allowedFrom)', async () => {
    try {
      await orderMachine.apply(makeOrder(), 'unknown' as OrderTransition)
      throw new Error('expected TransitionError')
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError)
      expect((err as TransitionError).code).toBe('machine.invalid-transition')
      expect((err as TransitionError).context).toEqual({
        transition: 'unknown',
        from: 'pending',
        allowedFrom: null,
      })
    }
  })

  test('wrong from-state → TransitionError (with allowedFrom)', async () => {
    try {
      // ship requires processing; order is pending.
      await orderMachine.apply(makeOrder({ status: 'pending' }), 'ship')
      throw new Error('expected TransitionError')
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError)
      expect((err as TransitionError).context).toEqual({
        transition: 'ship',
        from: 'pending',
        allowedFrom: ['processing'],
      })
    }
  })

  test('guard returning false → GuardError', async () => {
    try {
      await orderMachine.apply(makeOrder({ status: 'pending', locked: true }), 'cancel')
      throw new Error('expected GuardError')
    } catch (err) {
      expect(err).toBeInstanceOf(GuardError)
      expect((err as GuardError).code).toBe('machine.guard-rejected')
      expect((err as GuardError).context).toEqual({
        transition: 'cancel',
        from: 'pending',
      })
    }
  })

  test('guard throwing propagates verbatim — not wrapped in GuardError', async () => {
    const machine = defineMachine<Order, OrderState, OrderTransition>({
      ...orderMachineDef,
      guards: {
        cancel: () => {
          throw new Error('guard exploded')
        },
      },
    })
    try {
      await machine.apply(makeOrder({ status: 'pending' }), 'cancel')
      throw new Error('expected the guard throw to propagate')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('guard exploded')
      expect(err).not.toBeInstanceOf(GuardError)
    }
  })

  test('effect throw propagates after the mutation has happened', async () => {
    const machine = defineMachine<Order, OrderState, OrderTransition>({
      ...orderMachineDef,
      effects: {
        ship: async () => {
          throw new Error('shipping API down')
        },
      },
    })
    const order = makeOrder({ status: 'processing' })
    try {
      await machine.apply(order, 'ship')
      throw new Error('expected effect throw')
    } catch (err) {
      expect((err as Error).message).toBe('shipping API down')
    }
    // Field WAS mutated before the effect ran — apps that need atomicity
    // wrap the call in a transaction.
    expect(order.status).toBe('shipped')
  })
})

// ─── definition reflection ────────────────────────────────────────────────

describe('Machine — definition reflection', () => {
  test('exposes the raw definition for tooling / tests', () => {
    expect(orderMachine.definition.field).toBe('status')
    expect(orderMachine.definition.initial).toBe('pending')
    expect(orderMachine.definition.states).toEqual([
      'pending',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ])
    expect(Object.keys(orderMachine.definition.transitions).sort()).toEqual([
      'cancel',
      'deliver',
      'process',
      'ship',
    ])
  })
})
