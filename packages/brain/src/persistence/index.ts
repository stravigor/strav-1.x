// Public API of `@strav/brain/persistence` — recommended schema +
// repositories for persisting conversations (threads + turns) and
// human-in-the-loop suspended runs to Postgres via `@strav/database`.
//
// Apps that need a different backend implement `BrainStore`
// directly — the schemas + repositories are conveniences, not
// obligations.

export {
  BrainMessage,
  type BrainMessageRole,
} from './brain_message.ts'
export {
  type AppendTurnInput,
  BrainMessageRepository,
  type LoadMessagesOptions,
} from './brain_message_repository.ts'
export type {
  BrainStore,
  CreateThreadInput,
  LoadedSuspendedRun,
  LoadedThread,
  SaveSuspendedRunInput,
  SuspendedFilter,
  SuspendedSummary,
  ThreadFilter,
  ThreadSummary,
  TurnInput,
} from './brain_store.ts'
export {
  BrainSuspendedRun,
  type BrainSuspendedRunStatus,
} from './brain_suspended_run.ts'
export {
  type ListPendingOptions,
  BrainSuspendedRunRepository,
} from './brain_suspended_run_repository.ts'
export { BrainThread } from './brain_thread.ts'
export {
  BrainThreadRepository,
  type ListThreadsOptions,
} from './brain_thread_repository.ts'
export { DatabaseBrainStore } from './database_brain_store.ts'
export {
  brainMessageSchema,
  brainSuspendedRunSchema,
  brainThreadSchema,
} from './schemas/index.ts'
