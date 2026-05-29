/**
 * Internal discriminated union of step kinds. The Workflow class pushes
 * one entry per builder call; `run()` walks the list and dispatches by
 * `type`. Exported so tests / introspection tools can read the plan
 * without poking at `Workflow`'s private state.
 *
 * These shapes loosely-type the handler — the user-facing typed builder
 * on `Workflow<Input, Results>` narrows them at the call sites, but the
 * runtime queue lives in a single homogeneous array.
 */

import type {
  Compensator,
  LoopHandler,
  ParallelEntry,
  RouteResolver,
  StepHandler,
} from './types.ts'

export interface SequentialStep {
  type: 'step'
  name: string
  handler: StepHandler
  compensate?: Compensator
}

export interface ParallelStep {
  type: 'parallel'
  name: string
  entries: ParallelEntry[]
}

export interface RouteStep {
  type: 'route'
  name: string
  resolver: RouteResolver
  branches: Record<string, StepHandler>
}

export interface LoopStep {
  type: 'loop'
  name: string
  handler: LoopHandler
  maxIterations: number
  until?: (result: unknown, iteration: number) => boolean
  feedback?: (result: unknown) => unknown
  mapInput?: (ctx: { input: unknown; results: Record<string, unknown> }) => unknown
}

export type WorkflowStep = SequentialStep | ParallelStep | RouteStep | LoopStep
