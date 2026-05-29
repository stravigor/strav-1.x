/**
 * `DurableCompensateJob` — queue Job that runs saga compensation for
 * a terminally-failed run.
 *
 * Mirrors `DurableAdvanceJob`'s shape — minimal payload, runner owns
 * the state. Same rationale for `maxAttempts = 1`: the runner
 * iterates over compensators internally and swallows their
 * individual failures so the rollback finishes; if the runner
 * itself throws (e.g. a DB connection error mid-walk), the queue's
 * dead-letter is the right place for it.
 */

import { inject } from '@strav/kernel'
import { Job, type JobContext } from '@strav/queue'
import { DurableRunner } from './durable_runner.ts'

export interface DurableCompensatePayload {
  runId: string
}

@inject()
export class DurableCompensateJob extends Job<DurableCompensatePayload> {
  static override readonly jobName = 'durable.compensate'
  static override readonly maxAttempts = 1

  constructor(private readonly runner: DurableRunner) {
    super()
  }

  async handle(ctx: JobContext<DurableCompensatePayload>): Promise<void> {
    await this.runner.compensate(ctx.payload.runId)
  }
}
