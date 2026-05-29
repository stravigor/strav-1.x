# Transition lifecycle

Anatomy of what happens when you call `repo.transition(entity, name)` — the order each phase runs, where things can fail, and which events fire when. Worth reading before writing your first effect or guard, since the failure modes matter for keeping data consistent.

## The pipeline

```
┌────────────────────────────────────────────────────────────────────┐
│ 1. validate transition (TransitionError on miss or wrong from)     │
│ 2. run guard          (GuardError on false; throw → propagate)     │
│ 3. mutate entity[field] = to                                       │
│ 4. run effect         (throw → propagate, entity already mutated)  │
│ 5. Repository.update  (fires <resource>.updating / .updated)       │
│ 6. EventBus.emit      (only if events[transition] AND repo.events) │
└────────────────────────────────────────────────────────────────────┘
```

If any phase throws, every later phase is skipped. The earlier phases that already ran **stay done** — the field mutation in phase 3 is not rolled back if the effect in phase 4 throws.

## Why mutate before the effect

The effect needs to see the new state. If `ship`'s effect calls `sendShippingNotification(order)` and the function reads `order.status`, the value has to be `'shipped'`, not `'processing'`. Mutating after the effect would lose this — and forcing the effect to consume `meta.to` explicitly would make every effect signature awkward.

The tradeoff: the entity is mutated in-memory before persistence, so a throw in the effect leaves you with an out-of-sync model. **The remedy is transactional scope**:

```ts
await uow.run(async () => {
  await orderRepo.transition(order, 'ship')
  // If anything inside this block throws (including the effect),
  // the surrounding tx rolls back — including the UPDATE from phase 5.
  await inventoryRepo.decrement(order.sku)
})
```

The in-memory entity is still mutated after the rollback (TS objects don't know about transactions), but that doesn't matter — the database is consistent, and the next `Repository.find` will re-hydrate from the canonical state.

## Where guards belong (and don't)

Guards are for **state-dependent eligibility** that the machine can evaluate cheaply. `!order.locked`, `user.role === 'admin'`, `inventory.available >= order.quantity`. They run *every* time the transition is checked or applied.

Don't put expensive work in a guard. The guard fires on `can()`, `availableTransitions()` filtering, and twice during `apply()`:

```ts
// Guard runs ONCE here.
if (await orderRepo.can(order, 'ship')) {
  // Guard runs AGAIN here, inside transition() → machine.apply().
  await orderRepo.transition(order, 'ship')
}
```

For "should this transition be allowed given external state" that requires a DB / HTTP call, push it into the effect — the effect runs once per transition. The guard pattern is for cheap predicates.

## Where effects belong (and don't)

Effects are good for:

- **In-process notification**: emitting a private event, updating an in-memory cache, marking a related entity.
- **Queued external work**: dispatching a Job that sends an email, calls a webhook, or updates an external API.

Effects are **not** good for:

- **Direct external API calls** that aren't transactional. If `sendShippingNotification` is a `fetch(...)` call, the notification can go out and then the `update()` can fail — now the customer has been told they're shipped, but the DB says processing. Dispatch a Job instead; `@strav/queue`'s `DatabaseQueue` queues until the transaction commits, so the email only goes out if the row was saved.

- **Cross-resource updates** that need atomicity. Same reason: the effect runs before `Repository.update`. If you need "ship the order AND decrement inventory atomically", do both inside `UnitOfWork.run(...)` (see above), not in the ship effect.

## Events vs. lifecycle events

Two different things fire on a successful transition:

1. **Repository lifecycle events**: `order.updating` (cancelable, pre-commit) and `order.updated` (post-commit). These are the standard `@strav/database` events that every `Repository.update` fires — listeners that care about *any* update to the order table will hear about the transition automatically. Pattern: write your audit log here.

2. **Machine-defined events**: the string you put in `definition.events[transition]`. Only fires on transitions that have an `events.<name>` entry, only when the Repository was built with an `EventBus`. The payload is `{ entity, from, to, transition }`. Pattern: domain-level signals that don't care about all `order.updated` events, only specific transitions.

```ts
// Listener for "any change to an order".
events.on('order.updated', (ev) => audit.log(ev))

// Listener for "only the ship transition".
events.on('order.shipped', ({ entity, from, to }) => {
  metrics.increment('orders.shipped', { from })
})
```

The two are complementary. Use lifecycle events for cross-cutting concerns (audit, cache invalidation, denormalization); use machine events for domain-specific signals.

## Failure modes summary

| Failure | Field mutated? | Persisted? | Lifecycle event? | Machine event? |
|---|---|---|---|---|
| `TransitionError` (unknown transition) | no | no | no | no |
| `TransitionError` (wrong from) | no | no | no | no |
| `GuardError` (returned `false`) | no | no | no | no |
| Guard throws | no | no | no | no |
| Effect throws | **yes** | no | no | no |
| `Repository.update` throws | yes | no | `.updating` fired then cancelled by handler / DB; `.updated` no | no |
| Event listener throws | yes | yes | yes | partial (other listeners may still fire) |

The "effect throws — entity mutated, not persisted" row is the one to wire UnitOfWork around when it matters.

## Defining the initial state

`definition.initial` is the canonical name for the starting state. V1 doesn't auto-fill it on `Repository.create` — apps pass it explicitly:

```ts
await orderRepo.create({
  status: orderMachine.definition.initial,
  // …other columns
})
```

Or, more often, declare it as the schema default:

```ts
defineSchema('order', Archetype.Entity, (t) => {
  t.id()
  t.string('status').max(32).default('pending')   // ← matches orderMachine.definition.initial
  // …
})
```

Wiring `t.string('status').default(machine.definition.initial)` works too, but introduces an import-order dependency between the schema and the machine module. Both are fine; pick whichever you prefer keeping in sync.
