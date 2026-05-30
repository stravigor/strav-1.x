// Public API of @strav/durable.
//
// Crash-resumable workflows on top of @strav/queue + Postgres.
// Builder surface on `DurableWorkflow`:
//   - `.step(name, handler, opts?)` — sequential, retried, saga-compensated.
//   - `.sleep(name, delay)` — park for a duration.
//   - `.waitForSignal(name, signalName)` — pause until
//     `runner.signal(runId, name, payload?)`.
//   - `.parallel(name, branches)` — Promise.all-style fan-out.
//   - `.route(name, select, branches)` — single-branch routing.
//   - `.loop(name, condition, body)` — per-iteration journaled loop.
//   - `.childWorkflow(name, start)` — spawn a registered workflow
//     and wait for completion.

export { defineDurable } from './define_durable.ts'
export {
  DurableAdvanceJob,
  type DurableAdvancePayload,
} from './durable_advance_job.ts'
export {
  DurableCompensateJob,
  type DurableCompensatePayload,
} from './durable_compensate_job.ts'
export {
  DurableError,
  RunNotFoundError,
  WorkflowNotRegisteredError,
} from './durable_error.ts'
export { DurableProvider } from './durable_provider.ts'
export { DurableRunner, type DurableRunnerOptions } from './durable_runner.ts'
export { DurableWorkflow } from './durable_workflow.ts'
export { JOURNAL_UNIQUE_INDEX, workflowJournalSchema } from './journal_schema.ts'
export { workflowRunsSchema } from './runs_schema.ts'
export type {
  DurableChildWorkflow,
  DurableCompensator,
  DurableContext,
  DurableLoop,
  DurableLoopContext,
  DurableNode,
  DurableParallel,
  DurableRoute,
  DurableSleep,
  DurableStep,
  DurableStepHandler,
  DurableStepOptions,
  DurableWaitForSignal,
  RunSnapshot,
  RunStatus,
} from './types.ts'
export { WorkflowRegistry } from './workflow_registry.ts'
