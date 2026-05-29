# @strav/machine

Declarative finite-state machines for Strav 1.0. Define states, transitions, guards, effects, and event names; apply transitions to any entity. The `stateful(...)` Repository mixin layers in persistence + event emission.

> **Status: 1.0.0-alpha.7 — M5 slice 2 (state-machine foundation + `stateful()` mixin).**
> Shipping: **`defineMachine(...)`** → typed `Machine<TEntity, TState, TTransition>` (pure value, no DI), **`Machine.state` / `.is` / `.can` / `.availableTransitions` / `.apply`** with sync + async guards, **`stateful(Base, machine)`** Repository mixin with `.transition(entity, name)` that validates → mutates → runs effect → persists via `Repository.update` → emits via the Repository's `EventBus`, **`TransitionError`** (`machine.invalid-transition`, status 422) + **`GuardError`** (`machine.guard-rejected`, status 422) typed `StravError`s.
> Deferred: **Initial-state auto-fill on `Model.create()`** (use `Repository.create({ status: machine.definition.initial })` for now), **multi-field machines** (one state field per machine in V1), **history columns / audit log** (apps that need an audit trail listen on `<resource>.updated` and record the transition there), **per-transition queue dispatch sugar** (effects can `await queue.dispatch(...)` directly), **state diagram export** (`machine.toDot()` / `.toMermaid()` lands when an app needs visualization).

## Install

```bash
bun add @strav/machine
```

Peer deps: `@strav/kernel`, `@strav/database`.

## Minimal example

```ts
import { defineMachine, stateful } from '@strav/machine'
import { Repository } from '@strav/database'

type OrderState      = 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
type OrderTransition = 'process' | 'ship' | 'deliver' | 'cancel'

export const orderMachine = defineMachine<Order, OrderState, OrderTransition>({
  field: 'status',
  initial: 'pending',
  states: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
  transitions: {
    process: { from: 'pending',                 to: 'processing' },
    ship:    { from: 'processing',              to: 'shipped'    },
    deliver: { from: 'shipped',                 to: 'delivered'  },
    cancel:  { from: ['pending', 'processing'], to: 'cancelled'  },
  },
  guards:  { cancel: (order) => !order.locked },
  effects: { ship:   async (order) => sendShippingNotification(order) },
  events:  { ship:   'order.shipped' },
})

@inject()
export class OrderRepository extends stateful(Repository<Order>, orderMachine) {
  static override readonly schema = orderSchema
  static override readonly model = Order
  constructor(db: PostgresDatabase, events: EventBus) { super(db, events) }
}

// Use it
const order = await orderRepo.find('o1')
if (orderRepo.can(order, 'ship')) {
  await orderRepo.transition(order, 'ship')
  // → validates from-state + guard
  // → mutates order.status = 'shipped'
  // → runs the ship effect (sendShippingNotification)
  // → orderRepo.update(order, { status: 'shipped' }) — fires `order.updating` / `order.updated`
  // → orderRepo.events.emit('order.shipped', { entity: order, from: 'processing', to: 'shipped', transition: 'ship' })
}
```

Standalone (no Repository):

```ts
const draft = { status: 'pending' as OrderState }
await orderMachine.apply(draft, 'process')
draft.status // → 'processing'
```

`apply()` mutates in place and returns the `TransitionMeta`; it doesn't persist or emit. Use it for in-process objects, validation in request handlers, or workflow steps that don't go through a Repository.

## What's here

| Symbol | Purpose |
|---|---|
| `defineMachine<TEntity, TState, TTransition>(definition)` | Build a `Machine` from a declarative spec. Pure — no DI, no DB, no event bus |
| `Machine<TEntity, TState, TTransition>` | The runtime interface: `state`, `is`, `can`, `availableTransitions`, `apply`, `definition` |
| `MachineDefinition` / `TransitionDefinition` / `TransitionMeta` | The input shape + the "what just happened" record returned by `apply()` |
| `stateful(Base, machine)` | Class mixin — extends a Repository subclass with `is` / `can` / `availableTransitions` / `transition` |
| `RepositoryConstructor<TEntity>` | The constructor type the mixin accepts. Exported for apps that want to type their own mixin chains |
| `TransitionError` | Typed `StravError` (`machine.invalid-transition`, status 422). `context.transition`, `context.from`, `context.allowedFrom` (or `null` for "no such transition") |
| `GuardError` | Typed `StravError` (`machine.guard-rejected`, status 422). `context.transition`, `context.from` |

## Documentation

- [`api.md`](./api.md) — every public export with signature + semantics.
- [`guides/lifecycle.md`](./guides/lifecycle.md) — the full transition lifecycle (validate → guard → mutate → effect → persist → emit), where things can fail, and which events fire when.

## When NOT to use a machine

- **Free-form state.** If transitions don't have rules — any state can move to any other — you're better off without the ceremony. Just update the field.
- **One-shot orchestrations.** If you're modeling "step A then B then C" with conditional branches, that's a `@strav/workflow`, not a machine.
- **Multi-field state.** V1 has one state field per machine. Modeling combined state (`status` × `payment_status` × `inventory_status`) needs either three machines + a coordinator workflow, or a denormalized `phase` column the machine drives.
