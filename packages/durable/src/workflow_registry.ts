/**
 * `WorkflowRegistry` — name → `DurableWorkflow` lookup used by the
 * advance / compensate handlers.
 *
 * Mirrors `JobRegistry` from `@strav/queue`: explicit registration on
 * an instance, no module-singleton state. Each app builds one
 * registry, registers its workflows, and hands it to the runner.
 *
 * Duplicate-name registration throws — the runner journals steps by
 * (run, step name), so silently shadowing a registered workflow with
 * a different shape would corrupt replays.
 */

import { DurableError, WorkflowNotRegisteredError } from './durable_error.ts'
import type { DurableWorkflow } from './durable_workflow.ts'

export class WorkflowRegistry {
  private readonly workflows = new Map<string, DurableWorkflow>()

  register(workflow: DurableWorkflow): this {
    if (this.workflows.has(workflow.name)) {
      throw new DurableError(
        `WorkflowRegistry: workflow "${workflow.name}" is already registered. Refusing to shadow — re-name the workflow or restart the registry.`,
      )
    }
    this.workflows.set(workflow.name, workflow)
    return this
  }

  registerAll(workflows: readonly DurableWorkflow[]): this {
    for (const wf of workflows) this.register(wf)
    return this
  }

  /** Look up a workflow by name. Throws when missing. */
  get(name: string): DurableWorkflow {
    const wf = this.workflows.get(name)
    if (!wf) throw new WorkflowNotRegisteredError(name, [...this.workflows.keys()])
    return wf
  }

  has(name: string): boolean {
    return this.workflows.has(name)
  }

  names(): string[] {
    return [...this.workflows.keys()]
  }
}
