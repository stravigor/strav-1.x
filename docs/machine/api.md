# @strav/machine — API Reference

> **Status:** Reflects the state-machine foundation slice (M5.2).

## Public exports

```ts
import {
  // Builder + interface
  defineMachine,
  type Machine,
  // Definition shape + transition record
  type MachineDefinition,
  type TransitionDefinition,
  type TransitionMeta,
  // Repository mixin
  stateful,
  type RepositoryConstructor,
  // Errors
  TransitionError,
  GuardError,
} from '@strav/machine'
```

## `defineMachine(definition)`

```ts
function defineMachine<
  TEntity extends object,
  TState extends string,
  TTransition extends string,
>(
  definition: MachineDefinition<TEntity, TState, TTransition>,
): Machine<TEntity, TState, TTransition>
```

Returns a pure `Machine` — no DI, no DB, no event bus. The same machine can drive a POJO, a hydrated Model, or a request DTO. Persistence + event emission are layered on via the `stateful(...)` mixin.

Type parameters are usually inferred from the definition, but apps that want stricter narrowing pass them explicitly:

```ts
type OrderState = 'pending' | 'processing' | 'shipped'
type OrderTransition = 'process' | 'ship'

const m = defineMachine<Order, OrderState, OrderTransition>({ … })
```

## `Machine<TEntity, TState, TTransition>`

```ts
interface Machine<TEntity, TState, TTransition> {
  readonly definition: MachineDefinition<TEntity, TState, TTransition>

  state(entity: TEntity): TState
  is(entity: TEntity, state: TState): boolean
  can(entity: TEntity, transition: TTransition): boolean | Promise<boolean>
  availableTransitions(entity: TEntity): TTransition[]
  apply(entity: TEntity, transition: TTransition): Promise<TransitionMeta<TState, TTransition>>
}
```

### `state(entity)` / `is(entity, state)`

Read-only inspection. `state` reads the configured `field` directly; `is` is a typed equality check.

### `can(entity, transition)`

`true` when (1) the transition is defined, (2) the entity's current state is in the transition's `from` list, AND (3) the guard (if any) returns truthy. Returns `Promise<boolean>` when the registered guard is async; a sync `boolean` otherwise — apps that want a boolean today shouldn't be forced into a Promise when no guard is async.

### `availableTransitions(entity)`

Names of every transition currently valid from the entity's state, **ignoring guards**. Useful for rendering UI ("which buttons should this entity show?") where you may want to display the transition even when the guard would currently reject. Apps that need guard-aware lists should filter with `can()` on the client of this method.

### `apply(entity, transition)`

Validate the move + run the guard + **mutate the field in place** + run the effect. Returns `TransitionMeta` describing the move. Does **not** persist or emit.

Order of operations:

1. Look up the transition definition. Missing → `TransitionError({ allowedFrom: null })`.
2. Check the entity's current state against the `from` list. Mismatch → `TransitionError({ allowedFrom: […] })`.
3. Run the guard. Returning `false` → `GuardError`. Guard *throws* propagate verbatim (not wrapped in `GuardError`).
4. Mutate `entity[field] = transition.to`.
5. Run the per-transition effect (if any). Effects see the new state on the entity. Effect throws propagate verbatim — the entity has already been mutated; callers needing atomicity wrap the call in a transaction.

## `MachineDefinition`

```ts
interface MachineDefinition<TEntity, TState, TTransition> {
  field: string
  initial: TState
  states: readonly TState[]
  transitions: Record<TTransition, TransitionDefinition<TState>>
  guards?: Partial<Record<TTransition, (entity: TEntity) => boolean | Promise<boolean>>>
  effects?: Partial<Record<TTransition, (entity: TEntity, meta: TransitionMeta) => void | Promise<void>>>
  events?: Partial<Record<TTransition, string>>
}

interface TransitionDefinition<TState> {
  from: TState | readonly TState[]
  to: TState
}

interface TransitionMeta<TState, TTransition> {
  readonly from: TState
  readonly to: TState
  readonly transition: TTransition
}
```

| Field | Purpose |
|---|---|
| `field` | Property on the entity that holds the state value (typically a snake_case column like `status`) |
| `initial` | Initial state for new entities — apps that want a single source of truth use `definition.initial` rather than re-declaring it in their schema default |
| `states` | All valid state values. Used for typing + as a published surface (e.g. for a UI dropdown of all states) |
| `transitions` | Named transitions: `{ from, to }`. `from` can be a single state or an array |
| `guards` | Optional per-transition predicates — `false` blocks via `GuardError` |
| `effects` | Optional per-transition side-effect functions. Run after the mutation, with the new state visible on the entity |
| `events` | Optional per-transition event-bus names. Emitted only when the transition is applied via the `stateful(...)` mixin (which has access to a `EventBus`) |

## `stateful(Base, machine)`

```ts
function stateful<
  TBase extends RepositoryConstructor<TEntity>,
  TEntity extends object,
  TState extends string,
  TTransition extends string,
>(
  Base: TBase,
  machine: Machine<TEntity, TState, TTransition>,
): {
  // abstract — still requires `static schema`, `static model` from the concrete subclass
  new (...args: ConstructorParameters<TBase>): InstanceType<TBase> & {
    is(entity: TEntity, state: TState): boolean
    can(entity: TEntity, transition: TTransition): boolean | Promise<boolean>
    availableTransitions(entity: TEntity): TTransition[]
    transition(entity: TEntity, name: TTransition): Promise<TransitionMeta<TState, TTransition>>
  }
}
```

Class mixin. Pass the Repository subclass to extend + the machine to bolt on. The returned class stays abstract — the concrete subclass still provides `static schema = …` and `static model = …`.

### `repo.transition(entity, name)`

Validate → run guard → mutate → run effect → persist → emit. The persistence step is `this.update(entity, { [field]: meta.to })`, which fires the standard `<resource>.updating` / `<resource>.updated` Repository lifecycle events. The emit step uses `this.events.emit(machine.events[name], { entity, ...meta })`, but only when both the machine declares an `events.<name>` entry AND the Repository was constructed with an EventBus.

Throws:

- `TransitionError` — undefined or disallowed transition (no persist, no emit).
- `GuardError` — guard returned `false` (no persist, no emit; entity not mutated).
- Anything else — propagated verbatim. If a guard throws, the entity isn't mutated. If an effect throws, the entity is mutated in-memory but the `update()` hasn't fired. Apps that need this to be atomic wrap the call in `UnitOfWork.run(...)` or `TenantManager.withTenant(...)`.

### `RepositoryConstructor<TEntity>`

```ts
type RepositoryConstructor<TEntity extends object> = abstract new (...args: any[]) => Repository<TEntity>
```

The constructor type the mixin accepts. Exported for apps that want to stack their own mixins on top:

```ts
class OrderRepository extends stateful(searchable(Repository<Order>), orderMachine) { … }
```

## Errors

### `TransitionError`

```ts
class TransitionError extends StravError {
  code = 'machine.invalid-transition'
  status = 422
  context: {
    transition: string
    from: string
    allowedFrom: readonly string[] | null  // null when the transition name is undefined
  }
}
```

422 because the request shape is fine but the *entity* is in the wrong state for the action. Apps that want a different code per route can convert via the standard `StravError` `code` option.

### `GuardError`

```ts
class GuardError extends StravError {
  code = 'machine.guard-rejected'
  status = 422
  context: {
    transition: string
    from: string
  }
}
```

Distinct from `TransitionError` so apps can render different UX for "you can't do that from this state" vs "you can't do that right now". Guard *throws* (not `false`-returns) propagate as-is — they're an app error, not a "guard said no" signal.
