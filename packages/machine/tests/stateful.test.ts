/**
 * Tests for the `stateful(Base, machine)` Repository mixin.
 *
 * Rather than spinning a full SQL fake, the test extends Repository and
 * stubs the two methods the mixin actually calls: `update` (for the
 * persistence step) and the inherited `events` field (for the event-emit
 * step). That keeps the test focused on the mixin's wiring — the
 * Repository round-trip is covered by `packages/database/tests/repository.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import {
  Archetype,
  defineSchema,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
} from '@strav/database'
import { EventBus } from '@strav/kernel'
import { defineMachine, type Machine, stateful } from '../src/index.ts'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const orderSchema = defineSchema('order', Archetype.Entity, (t) => {
  t.id()
  t.string('status').max(32)
  t.boolean('locked').default(false)
  t.timestamps()
})

class Order extends Model {
  static override readonly schema = orderSchema
  id!: string
  status!: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
  locked!: boolean
  created_at!: Date
  updated_at!: Date
}

type OrderState = Order['status']
type OrderTransition = 'process' | 'ship' | 'deliver' | 'cancel'

const orderMachine: Machine<Order, OrderState, OrderTransition> = defineMachine({
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
    cancel: (order) => !order.locked,
  },
  events: {
    ship: 'order.shipped',
    deliver: 'order.delivered',
  },
})

/**
 * Repository subclass with `update` stubbed — the mixin's
 * `transition()` calls it after the machine mutation. Keeping it as a
 * plain pass-through lets us assert the call shape without running real
 * SQL. The other Repository methods aren't exercised by the mixin
 * tests and don't need stubbing.
 */
class TestOrderRepository extends stateful(Repository<Order>, orderMachine) {
  static override readonly schema = orderSchema
  static override readonly model: ModelClass = Order as unknown as ModelClass

  updateCalls: Array<{ model: Order; changes: Partial<Order> }> = []

  override async update(model: Order, changes: Partial<Order>): Promise<Order> {
    this.updateCalls.push({ model, changes })
    Object.assign(model, changes)
    return model
  }
}

function repo(events?: EventBus): TestOrderRepository {
  // Repository's constructor only needs `db` to satisfy the type; the
  // mixin's `transition()` doesn't touch it. Pass a sentinel cast.
  return new TestOrderRepository({ db: undefined as unknown as PostgresDatabase, events })
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return Object.assign(new Order(), {
    id: 'o1',
    status: 'pending' as OrderState,
    locked: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  })
}

// ─── Read-side delegates ─────────────────────────────────────────────────

describe('stateful() mixin — read methods', () => {
  test('is / can / availableTransitions delegate to the machine', () => {
    const r = repo()
    const order = makeOrder({ status: 'processing' })
    expect(r.is(order, 'processing')).toBe(true)
    expect(r.is(order, 'pending')).toBe(false)
    expect(r.can(order, 'ship')).toBe(true)
    expect(r.can(order, 'process')).toBe(false)
    expect(r.availableTransitions(order).sort()).toEqual(['cancel', 'ship'])
  })
})

// ─── transition(): persistence + emit ─────────────────────────────────────

describe('stateful() mixin — transition()', () => {
  test('mutates → persists → returns meta', async () => {
    const r = repo()
    const order = makeOrder({ status: 'pending' })
    const meta = await r.transition(order, 'process')

    expect(meta).toEqual({ from: 'pending', to: 'processing', transition: 'process' })
    expect(order.status).toBe('processing')
    expect(r.updateCalls).toHaveLength(1)
    expect(r.updateCalls[0]?.model).toBe(order)
    expect(r.updateCalls[0]?.changes).toEqual({ status: 'processing' })
  })

  test('emits the configured event when an EventBus is bound', async () => {
    const bus = new EventBus()
    const seen: Array<{ name: string; payload: unknown }> = []
    bus.on('order.shipped', (payload) => {
      seen.push({ name: 'order.shipped', payload })
    })
    const r = repo(bus)
    const order = makeOrder({ status: 'processing' })

    await r.transition(order, 'ship')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe('order.shipped')
    expect(seen[0]?.payload).toMatchObject({
      entity: { id: 'o1', status: 'shipped' },
      from: 'processing',
      to: 'shipped',
      transition: 'ship',
    })
  })

  test('skips event emission when no EventBus is bound', async () => {
    // Build the repo without an EventBus — the mixin should still
    // persist + return cleanly, just without emitting.
    const r = repo()
    const order = makeOrder({ status: 'processing' })
    await expect(r.transition(order, 'ship')).resolves.toMatchObject({
      from: 'processing',
      to: 'shipped',
    })
    expect(r.updateCalls).toHaveLength(1)
  })

  test('skips emission when the machine has no event for this transition', async () => {
    const bus = new EventBus()
    let calls = 0
    bus.on('*', () => {
      calls++
    })
    const r = repo(bus)
    const order = makeOrder({ status: 'pending' })
    await r.transition(order, 'process') // no events.process entry
    expect(calls).toBe(0)
  })

  test('GuardError from the machine surfaces — no persist, no emit', async () => {
    const bus = new EventBus()
    let emits = 0
    bus.on('*', () => {
      emits++
    })
    const r = repo(bus)
    const order = makeOrder({ status: 'pending', locked: true })
    try {
      await r.transition(order, 'cancel')
      throw new Error('expected GuardError')
    } catch (err) {
      expect((err as Error).message).toMatch(/Guard rejected/)
    }
    expect(r.updateCalls).toHaveLength(0)
    expect(emits).toBe(0)
    // The entity wasn't mutated either — guards run before mutation.
    expect(order.status).toBe('pending')
  })
})
