// Public API of @strav/workflow.
//
// Workflow orchestration — sequential, parallel, route, loop, plus
// saga-style compensation. Pure functions on `@strav/kernel` (no DB,
// no HTTP, no provider). Apps construct workflows where they need
// them; shared workflows live in module-level `export const`s.

export { CompensationError, type CompensationFailure } from './compensation_error.ts'
export { defineWorkflow } from './define_workflow.ts'
export type { LoopStep, ParallelStep, RouteStep, SequentialStep, WorkflowStep } from './step.ts'
export type {
  Compensator,
  LoopHandler,
  LoopOptions,
  ParallelEntry,
  RouteResolver,
  StepHandler,
  StepOptions,
  WorkflowContext,
  WorkflowResult,
} from './types.ts'
export { Workflow } from './workflow.ts'
export { WorkflowError } from './workflow_error.ts'
