// Public API of @strav/machine.
//
// State machines + a `stateful()` Repository mixin. The machine itself is
// pure (no DI, no DB, no event bus). The mixin layers in persistence
// via Repository.update + optional event emission via the Repository's
// EventBus.

export { defineMachine } from './define_machine.ts'
export { GuardError } from './guard_error.ts'
export type { Machine } from './machine.ts'
export type {
  MachineDefinition,
  TransitionDefinition,
  TransitionMeta,
} from './machine_definition.ts'
export { type RepositoryConstructor, stateful } from './stateful.ts'
export { TransitionError } from './transition_error.ts'
