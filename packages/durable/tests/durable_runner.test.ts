/**
 * `DurableRunner` engine tests — happy path, idempotent replay,
 * per-step retries with the runner's queue dispatch, and saga
 * compensation on terminal failure.
 *
 * Runs against a real Postgres via the shared test helper. Uses a
 * `FakeQueue` that records dispatch calls so tests can drive the
 * engine deterministically — the runner enqueues; the test pulls
 * the next job off the queue and calls `runner.advance` /
 * `runner.compensate` directly.
 *
 * Self-skips when no Postgres is available.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type Database,
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

// ─── Fake Queue ──────────────────────────────────────────────────────────

interface DispatchedJob {
  jobClass: JobClass
  payload: unknown
  delaySeconds: number
}

class FakeQueue implements Queue {
  readonly dispatched: DispatchedJob[] = []

  async dispatch<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
  ): Promise<string> {
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
    throw new Error('dispatchSync not implemented for FakeQueue')
  }

  /** Pull and clear the next dispatched job. */
  next(): DispatchedJob | undefined {
    return this.dispatched.shift()
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('DurableRunner — engine', () => {
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

  // ─── Happy path ──────────────────────────────────────────────────────

  test('start → advance walks every step, marks completed, journals each step', async () => {
    const calls: string[] = []
    const wf = new DurableWorkflow('happy')
      .step('a', async () => {
        calls.push('a')
        return { aResult: 1 }
      })
      .step('b', async (ctx) => {
        calls.push('b')
        return { from: (ctx.results.a as { aResult: number }).aResult + 1 }
      })
    registry.register(wf)

    const runId = await runner.start('happy', { seed: 'q' })

    // First advance dispatch — the start.
    let job = queue.next()!
    expect(job.jobClass).toBe(DurableAdvanceJob)
    await runner.advance(runId)

    // Each step's success enqueues the next advance.
    while ((job = queue.next()!)) {
      if (job.jobClass !== DurableAdvanceJob) break
      await runner.advance(runId)
    }

    expect(calls).toEqual(['a', 'b'])

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results).toEqual({
      a: { aResult: 1 },
      b: { from: 2 },
    })
    expect(snapshot.result).toEqual({ a: { aResult: 1 }, b: { from: 2 } })
    expect(snapshot.error).toBeNull()
  })

  test('start dispatches inside a transaction (run row + first advance commit together)', async () => {
    registry.register(new DurableWorkflow('demo').step('a', async () => 'r'))
    const runId = await runner.start('demo')
    // The run row exists.
    const snapshot = await runner.find(runId)
    expect(snapshot.workflowName).toBe('demo')
    // And exactly one advance job was dispatched.
    expect(queue.dispatched).toHaveLength(1)
    expect(queue.dispatched[0]?.jobClass).toBe(DurableAdvanceJob)
    expect((queue.dispatched[0]?.payload as { runId: string }).runId).toBe(runId)
  })

  // ─── Idempotent replay ───────────────────────────────────────────────

  test('replaying an advance job with a completed journal entry skips the handler', async () => {
    let calls = 0
    const wf = new DurableWorkflow('replay')
      .step('once', async () => {
        calls++
        return { ran: true }
      })
      .step('two', async () => 'two-result')
    registry.register(wf)

    const runId = await runner.start('replay')
    queue.next() // drop initial dispatch
    await runner.advance(runId) // runs 'once'
    expect(calls).toBe(1)

    // Drain the dispatched advance-for-step-2 job, then re-run advance
    // AGAIN against the same run id — simulates queue redelivery
    // after a worker died right after committing the journal.
    queue.next()
    await runner.advance(runId)
    // 'once' already journaled completed → not re-run.
    expect(calls).toBe(1)

    // Continue draining; should land in 'two', then complete.
    while (queue.next()) {
      await runner.advance(runId)
    }
    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.once).toEqual({ ran: true })
  })

  // ─── Retries ─────────────────────────────────────────────────────────

  test('failing step retries with backoff until it succeeds, then resumes', async () => {
    let attempts = 0
    const wf = new DurableWorkflow('retry').step(
      'flaky',
      async (ctx) => {
        attempts++
        expect(ctx.attempt).toBe(attempts) // attempts surfaced 1-based to the handler
        if (attempts < 3) throw new Error(`fail ${attempts}`)
        return { recovered: true }
      },
      { backoff: () => 0 }, // fast tests — zero-delay retries
    )
    registry.register(wf)

    const runId = await runner.start('retry')
    queue.next() // initial dispatch
    await runner.advance(runId) // attempt 1 — fails, schedules retry

    // Each failure enqueues a delayed advance via dispatchLater.
    let job = queue.next()
    while (job && job.jobClass === DurableAdvanceJob) {
      await runner.advance(runId)
      job = queue.next()
    }

    expect(attempts).toBe(3)
    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.results.flaky).toEqual({ recovered: true })
  })

  test('exhausted retries journal the failure and dispatch a compensate job', async () => {
    let attempts = 0
    const wf = new DurableWorkflow('exhaust').step(
      'always-fails',
      async () => {
        attempts++
        throw new Error(`fail ${attempts}`)
      },
      { maxAttempts: 2, backoff: () => 0 },
    )
    registry.register(wf)

    const runId = await runner.start('exhaust')
    queue.next() // initial
    await runner.advance(runId) // attempt 1 — fails, schedules retry

    // Drain retry, expecting it to terminate after attempt 2.
    let job = queue.next()
    while (job && job.jobClass === DurableAdvanceJob) {
      await runner.advance(runId)
      job = queue.next()
    }

    expect(attempts).toBe(2)
    expect(job?.jobClass).toBe(DurableCompensateJob)

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('compensating')
    expect(snapshot.error).toMatch(/fail 2/)
  })

  // ─── Compensation ────────────────────────────────────────────────────

  test('compensate walks completed-journal entries in reverse running compensators', async () => {
    const events: string[] = []
    const wf = new DurableWorkflow('saga')
      .step(
        'reserve',
        async () => {
          events.push('reserve.run')
          return { reservation: 'r1' }
        },
        {
          compensate: async () => {
            events.push('reserve.compensate')
          },
        },
      )
      .step(
        'charge',
        async () => {
          events.push('charge.run')
          return { id: 'ch_1' }
        },
        {
          compensate: async () => {
            events.push('charge.compensate')
          },
        },
      )
      .step(
        'ship',
        async () => {
          events.push('ship.run')
          throw new Error('ship blew up')
        },
        {
          maxAttempts: 1,
          backoff: () => 0,
        },
      )
    registry.register(wf)

    const runId = await runner.start('saga')
    // Drive the engine: each advance call may enqueue the next; loop
    // until we see a compensate dispatch waiting in the queue.
    let job = queue.next() // initial advance dispatched by start()
    while (job) {
      if (job.jobClass !== DurableAdvanceJob) break
      await runner.advance(runId)
      job = queue.next()
    }
    expect(job?.jobClass).toBe(DurableCompensateJob)

    await runner.compensate(runId)

    // Steps ran in order; compensators ran in reverse on completed
    // steps only — `ship` had no committed work so no compensator
    // runs for it.
    expect(events).toEqual([
      'reserve.run',
      'charge.run',
      'ship.run',
      'charge.compensate',
      'reserve.compensate',
    ])

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('failed')
  })

  test('compensator that throws is logged and skipped; remaining compensators still run', async () => {
    const events: string[] = []
    const wf = new DurableWorkflow('partial-failure')
      .step('a', async () => 'a-r', {
        compensate: async () => {
          events.push('a.compensate')
        },
      })
      .step('b', async () => 'b-r', {
        compensate: async () => {
          events.push('b.compensate')
          throw new Error('b cleanup blew up')
        },
      })
      .step('c', async () => {
        throw new Error('c failed')
      }, { maxAttempts: 1, backoff: () => 0 })
    registry.register(wf)

    const runId = await runner.start('partial-failure')
    let job = queue.next()
    while (job) {
      if (job.jobClass !== DurableAdvanceJob) break
      await runner.advance(runId)
      job = queue.next()
    }
    await runner.compensate(runId)

    // b's compensator threw but a's still ran.
    expect(events).toEqual(['b.compensate', 'a.compensate'])

    const snapshot = await runner.find(runId)
    expect(snapshot.status).toBe('failed')
  })

  // ─── Edge cases ──────────────────────────────────────────────────────

  test('start rejects synchronously when the workflow is not registered', async () => {
    await expect(runner.start('missing')).rejects.toThrow(/not registered/)
  })

  test('find throws RunNotFoundError when the run id is unknown', async () => {
    await expect(runner.find('01NOTAREALRUNID000000000000')).rejects.toThrow(/not found/)
  })

  test('advance on an already-completed run is a no-op', async () => {
    let calls = 0
    const wf = new DurableWorkflow('done').step('a', async () => {
      calls++
      return 'r'
    })
    registry.register(wf)

    const runId = await runner.start('done')
    queue.next()
    await runner.advance(runId) // a runs
    while (queue.next()) await runner.advance(runId)
    expect(calls).toBe(1)

    // Re-firing advance after completion does nothing.
    await runner.advance(runId)
    expect(calls).toBe(1)
  })
})

// Reference an unused import so verbatimModuleSyntax stays happy.
const _ref: Database | undefined = undefined
void _ref
