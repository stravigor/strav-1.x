/**
 * `DurableAdvanceJob` — queue Job that moves a durable run forward
 * by one step.
 *
 * Payload is just `{ runId }` — the runner reads everything else off
 * the run row + the registry. Keeping the payload minimal protects
 * against schema drift between the dispatcher and the worker: a
 * worker on an older deploy can still process jobs queued by the
 * latest deploy as long as the registry shape matches.
 *
 * `maxAttempts = 1` because retry semantics live INSIDE the runner
 * (per-step retries with configurable backoff), not at the Job
 * layer. If the runner throws here it means the engine itself
 * failed — those should land in the queue's dead-letter via the
 * standard Worker pipeline, not get silently retried.
 */

import { inject } from '@strav/kernel'
import { Job, type JobContext } from '@strav/queue'
import { DurableRunner } from './durable_runner.ts'

export interface DurableAdvancePayload {
  runId: string
}

@inject()
export class DurableAdvanceJob extends Job<DurableAdvancePayload> {
  static override readonly jobName = 'durable.advance'
  static override readonly maxAttempts = 1

  constructor(private readonly runner: DurableRunner) {
    super()
  }

  async handle(ctx: JobContext<DurableAdvancePayload>): Promise<void> {
    await this.runner.advance(ctx.payload.runId)
  }
}
