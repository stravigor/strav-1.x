/**
 * V2 node-type integration tests against a real Postgres. Mirrors the
 * V1 runner suite's `FakeQueue` pattern — the test pulls dispatched
 * jobs and calls `runner.advance` / `runner.signal` directly so each
 * step boundary is deterministic.
 *
 * Self-skips when no Postgres is available (same env-driven pattern
 * as the V1 suite).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  emitCreateIndex,
  emitCreateTable,
  type PostgresDatabase,
  SchemaRegistry,
} from '@strav/database'
import type { JobClass, PayloadOf, Queue } from '@strav/queue'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../../../tests/support/postgres_test_db.ts'
import {
  DurableAdvanceJob,
  DurableCompensateJob,
  DurableRunner,
  DurableWorkflow,
  JOURNAL_UNIQUE_INDEX,
  workflowJournalSchema,
  workflowRunsSchema,
  WorkflowRegistry,
} from '../src/index.ts'

const PG_AVAILABLE = await isPostgresAvailable()

interface DispatchedJob {
  jobClass: JobClass
  payload: unknown
  delaySeconds: number
}

class FakeQueue implements Queue {
  readonly dispatched: DispatchedJob[] = []
  async dispatch<TJob extends JobClass>(jobClass: TJob, payload: PayloadOf<TJob>): Promise<string> {
    this.dispatched.push({ jobClass, payload, delaySeconds: 0 })
    return `job-${this.dispatched.length}`
  }
  async dispatchLater<TJob extends JobClass>(
    at: Date | number,
    jobClass: TJob,
    payload: PayloadOf<TJob>,
  ): Promise<string> {
    const delaySeconds = typeof at === 'number' ? at : Math.max(0, (at.getTime() - Date.now()) / 1000)
    this.dispatched.push({ jobClass, payload, delaySeconds })
    return `job-${this.dispatched.length}`
  }
  async dispatchSync(): Promise<void> {
    throw new Error('not used')
  }
  next(): DispatchedJob | undefined {
    return this.dispatched.shift()
  }
}

/** Drain every advance job on the queue until none are left or a non-advance job appears. */
async function drainAdvances(runner: DurableRunner, queue: FakeQueue): Promise<void> {
  let job = queue.next()
  while (job !== undefined) {
    if (job.jobClass !== DurableAdvanceJob) break
    const runId = (job.payload as { runId: string }).runId
    await runner.advance(runId)
    job = queue.next()
  }
}

describe.skipIf(!PG_AVAILABLE)('DurableRunner — V2 node types', () => {
  let db: PostgresDatabase
  let queue: FakeQueue
  let registry: WorkflowRegistry
  let runner: DurableRunner

  beforeAll(async () => {
    db = createTestDatabase()
    await resetSchema(db)
    const schemas = new SchemaRegistry().registerAll([workflowRunsSchema, workflowJournalSchema])
    await db.execute(emitCreateTable(workflowRunsSchema, { registry: schemas }).sql)
    await db.execute(emitCreateTable(workflowJournalSchema, { registry: schemas }).sql)
    await db.execute(
      emitCreateIndex('strav_workflow_journal', ['run_id', 'step_name'], {
        unique: true,
        name: JOURNAL_UNIQUE_INDEX,
      }).sql,
    )
  })

  afterAll(async () => {
    await db?.close({ timeout: 2 })
  })

  beforeEach(async () => {
    await db.execute(`TRUNCATE "strav_workflow_runs", "strav_workflow_journal"`)
    queue = new FakeQueue()
    registry = new WorkflowRegistry()
    runner = new DurableRunner({
      db,
      queue,
      registry,
      advanceJob: DurableAdvanceJob,
      compensateJob: DurableCompensateJob,
    })
  })

  // ─── sleep ───────────────────────────────────────────────────────────

  test('sleep parks the run, schedules a delayed advance, and resumes on wake', async () => {
    const wf = new DurableWorkflow('s').sleep('nap', 0).step('after', async () => 'done')
    registry.register(wf)
    const runId = await runner.start('s')

    queue.next() // initial advance
    await runner.advance(runId) // hits sleep

    let snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('waiting')

    // The runner scheduled a wake-up advance for `nap`.
    const wake = queue.next()
    expect(wake?.jobClass).toBe(DurableAdvanceJob)

    await runner.advance(runId) // wake-up → journal sleep + advance cursor
    await drainAdvances(runner, queue)

    snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.after).toBe('done')
  })

  // ─── waitForSignal ───────────────────────────────────────────────────

  test('waitForSignal parks the run; signal() resumes with the payload as result', async () => {
    const wf = new DurableWorkflow('w')
      .waitForSignal('approval', 'approve.order')
      .step('after', async (ctx) => ctx.results.approval)
    registry.register(wf)
    const runId = await runner.start('w')

    queue.next()
    await runner.advance(runId)

    expect((await runner.find(runId)).status).toBe('waiting')
    // No wake-up scheduled — signal is purely external.
    expect(queue.dispatched).toHaveLength(0)

    const accepted = await runner.signal(runId, 'approve.order', { decision: 'yes' })
    expect(accepted).toBe(true)
    await drainAdvances(runner, queue)

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.approval).toEqual({ decision: 'yes' })
    expect(snapshot.results.after).toEqual({ decision: 'yes' })
  })

  test('signal() with the wrong name does not resume', async () => {
    const wf = new DurableWorkflow('w').waitForSignal('approval', 'approve.order')
    registry.register(wf)
    const runId = await runner.start('w')
    queue.next()
    await runner.advance(runId)

    const accepted = await runner.signal(runId, 'reject.order', {})
    expect(accepted).toBe(false)
    expect((await runner.find(runId)).status).toBe('waiting')
  })

  // ─── parallel ────────────────────────────────────────────────────────

  test('parallel fans out to every branch and collects results by branch name', async () => {
    const wf = new DurableWorkflow('p')
      .parallel('fanout', {
        a: async () => ({ x: 1 }),
        b: async () => ({ y: 2 }),
        c: async () => 'plain',
      })
      .step('after', async (ctx) => ctx.results.fanout)
    registry.register(wf)
    const runId = await runner.start('p')

    queue.next()
    await runner.advance(runId)
    await drainAdvances(runner, queue)

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.fanout).toEqual({
      a: { x: 1 },
      b: { y: 2 },
      c: 'plain',
    })
  })

  test('parallel: one branch throwing fails the whole node + triggers compensation', async () => {
    const compensated: string[] = []
    const wf = new DurableWorkflow('p')
      .step(
        'pre',
        async () => 'pre',
        { compensate: async () => void compensated.push('pre') },
      )
      .parallel(
        'fanout',
        {
          ok: async () => 'ok',
          bad: async () => {
            throw new Error('boom')
          },
        },
        { maxAttempts: 1, backoff: () => 0 },
      )
    registry.register(wf)
    const runId = await runner.start('p')

    queue.next()
    await runner.advance(runId) // pre
    let job = queue.next()
    while (job?.jobClass === DurableAdvanceJob) {
      await runner.advance(runId)
      job = queue.next()
    }
    // Now we should be on a compensate job.
    expect(job?.jobClass).toBe(DurableCompensateJob)
    await runner.compensate(runId)

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toBe('boom')
    expect(compensated).toEqual(['pre'])
  })

  // ─── route ───────────────────────────────────────────────────────────

  test('route invokes the selected branch and stores branch+result', async () => {
    const wf = new DurableWorkflow('r').route(
      'choice',
      (ctx) => ctx.input.kind as string,
      {
        a: async () => 'branch-a',
        b: async () => 'branch-b',
      },
    )
    registry.register(wf)
    const runId = await runner.start('r', { kind: 'b' })

    queue.next()
    await runner.advance(runId)
    await drainAdvances(runner, queue)

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.choice).toEqual({ branch: 'b', result: 'branch-b' })
  })

  test('route with an unknown branch fails the node', async () => {
    const wf = new DurableWorkflow('r').route(
      'choice',
      () => 'missing',
      { a: async () => 'A' },
      { maxAttempts: 1, backoff: () => 0 },
    )
    registry.register(wf)
    const runId = await runner.start('r')
    queue.next()
    await runner.advance(runId)
    let job = queue.next()
    while (job?.jobClass === DurableAdvanceJob) {
      await runner.advance(runId)
      job = queue.next()
    }
    expect(job?.jobClass).toBe(DurableCompensateJob)
    await runner.compensate(runId)
    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toMatch(/unknown branch "missing"/)
  })

  // ─── loop ────────────────────────────────────────────────────────────

  test('loop iterates while the condition holds and collects per-iteration results', async () => {
    const wf = new DurableWorkflow('l')
      .loop(
        'each',
        (_ctx, i) => i < 3,
        async (ctx) => ctx.iteration * 10,
      )
      .step('after', async (ctx) => ctx.results.each)
    registry.register(wf)
    const runId = await runner.start('l')

    queue.next()
    await runner.advance(runId)
    await drainAdvances(runner, queue)

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.each).toEqual([0, 10, 20])
    expect(snapshot.results.after).toEqual([0, 10, 20])
  })

  test('loop with condition false from the start completes empty', async () => {
    const wf = new DurableWorkflow('l').loop(
      'each',
      () => false,
      async () => 'never',
    )
    registry.register(wf)
    const runId = await runner.start('l')
    queue.next()
    await runner.advance(runId)
    await drainAdvances(runner, queue)
    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.each).toEqual([])
  })

  // ─── childWorkflow ───────────────────────────────────────────────────

  test('childWorkflow spawns + polls + surfaces the child result', async () => {
    registry.register(new DurableWorkflow('child').step('do', async () => ({ from: 'child' })))
    const parent = new DurableWorkflow('parent')
      .childWorkflow('sub', async () => ({ name: 'child' }), { pollIntervalSec: 0 })
      .step('after', async (ctx) => ctx.results.sub)
    registry.register(parent)

    const runId = await runner.start('parent')

    // Drain the queue: parent + child both push advance jobs.
    let job = queue.next()
    while (job !== undefined) {
      if (job.jobClass !== DurableAdvanceJob) break
      await runner.advance((job.payload as { runId: string }).runId)
      job = queue.next()
    }

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.sub).toEqual({ do: { from: 'child' } })
    expect(snapshot.results.after).toEqual({ do: { from: 'child' } })
  })

  test('childWorkflow propagates a failed child as a node failure', async () => {
    registry.register(
      new DurableWorkflow('child').step(
        'die',
        async () => {
          throw new Error('child boom')
        },
        { maxAttempts: 1, backoff: () => 0 },
      ),
    )
    registry.register(
      new DurableWorkflow('parent').childWorkflow(
        'sub',
        async () => ({ name: 'child' }),
        { pollIntervalSec: 0 },
      ),
    )

    const runId = await runner.start('parent')
    let job = queue.next()
    while (job !== undefined) {
      if (job.jobClass === DurableAdvanceJob) {
        await runner.advance((job.payload as { runId: string }).runId)
      } else if (job.jobClass === DurableCompensateJob) {
        await runner.compensate((job.payload as { runId: string }).runId)
      } else {
        break
      }
      job = queue.next()
    }

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toBe('child boom')
  })
})
