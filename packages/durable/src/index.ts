// Public API of @strav/durable.
//
// Crash-resumable workflows on top of @strav/queue + Postgres. V1
// ships sequential `.step()` with per-step retries and saga
// compensation. V2 layers in parallel / route / loop / sleep /
// waitForSignal / childWorkflow.

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
  DurableCompensator,
  DurableContext,
  DurableStep,
  DurableStepHandler,
  DurableStepOptions,
  RunSnapshot,
  RunStatus,
} from './types.ts'
export { WorkflowRegistry } from './workflow_registry.ts'
