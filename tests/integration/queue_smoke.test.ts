/**
 * Integration smoke for @strav/queue — proves DatabaseQueue against a
 * real Postgres.
 *
 *   1. The strav_jobs table emits + accepts DDL.
 *   2. `dispatch` inserts a row visible to a follow-up SELECT.
 *   3. `dispatchLater` writes `available_at` in the future.
 *   4. Inside `UnitOfWork.run`, dispatch routes through the ambient tx
 *      — rollback drops the row (the M3 queue-until-commit spike).
 *
 * Self-skips when no Postgres is available — same shape as the other
 * integration suites.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  emitCreateTable,
  type PostgresDatabase,
  SchemaRegistry,
  TenantManager,
  UnitOfWork,
} from '../../packages/database/src/index.ts'
import { Application, EventBus } from '../../packages/kernel/src/index.ts'
import {
  DatabaseQueue,
  everyMinute,
  failedJobsSchema,
  Job,
  type JobContext,
  type JobFailedContext,
  JobRegistry,
  jobSchema,
  Scheduler,
  schedulerRunsSchema,
  Worker,
} from '../../packages/queue/src/index.ts'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../support/postgres_test_db.ts'

const PG_AVAILABLE = await isPostgresAvailable()

class TestJob extends Job<{ note: string }> {
  static override readonly jobName = 'integration.queue-smoke'
  async handle(_ctx: JobContext<{ note: string }>): Promise<void> {
    // no-op — the smoke just exercises persistence
  }
}

interface JobRow {
  id: string
  queue: string
  job_name: string
  payload: { note: string }
  attempts: number
  max_attempts: number
  available_at: Date
  reserved_at: Date | null
}

describe.skipIf(!PG_AVAILABLE)('integration: @strav/queue DatabaseQueue smoke', () => {
  let db: PostgresDatabase
  let queue: DatabaseQueue

  beforeAll(async () => {
    db = createTestDatabase()
    await resetSchema(db)

    const registry = new SchemaRegistry().registerAll([
      jobSchema,
      schedulerRunsSchema,
      failedJobsSchema,
    ])
    await db.execute(emitCreateTable(jobSchema, { registry }).sql)
    await db.execute(emitCreateTable(schedulerRunsSchema, { registry }).sql)
    await db.execute(emitCreateTable(failedJobsSchema, { registry }).sql)

    queue = new DatabaseQueue({ db, container: new Application() })
  })

  afterAll(async () => {
    await db.close({ timeout: 2 })
  })

  test('emitCreateTable for jobSchema is accepted by the real planner', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      ['strav_jobs'],
    )
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'queue',
      'job_name',
      'payload',
      'attempts',
      'max_attempts',
      'available_at',
      'reserved_at',
      'created_at',
      'updated_at',
    ])
  })

  test('dispatch writes a row visible to a follow-up SELECT', async () => {
    const jobId = await queue.dispatch(TestJob, { note: 'persisted' })
    const row = await db.queryOne<JobRow>(`SELECT * FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(row).not.toBeNull()
    expect(row?.queue).toBe('default')
    expect(row?.job_name).toBe('integration.queue-smoke')
    // pg returns jsonb as parsed JSON.
    expect(row?.payload).toEqual({ note: 'persisted' })
    expect(Number(row?.attempts)).toBe(0)
    expect(Number(row?.max_attempts)).toBe(3)
    expect(row?.reserved_at).toBeNull()
  })

  test('dispatchLater writes available_at in the future', async () => {
    const jobId = await queue.dispatchLater(60, TestJob, { note: 'later' })
    const row = await db.queryOne<JobRow>(
      `SELECT id, available_at, now() AS now FROM "strav_jobs" WHERE id = $1`,
      [jobId],
    )
    expect(row).not.toBeNull()
    const availableAt = row?.available_at.getTime() ?? 0
    const now = (row as unknown as { now: Date }).now.getTime()
    const deltaSeconds = (availableAt - now) / 1000
    expect(deltaSeconds).toBeGreaterThanOrEqual(58)
    expect(deltaSeconds).toBeLessThanOrEqual(62)
  })

  test('dispatch inside UnitOfWork.run commits with the transaction', async () => {
    const uow = new UnitOfWork(db, new EventBus())
    let jobId = ''
    await uow.run(async () => {
      jobId = await queue.dispatch(TestJob, { note: 'committed' })
    })
    // After commit, the row should be visible from outside the tx.
    const row = await db.queryOne<JobRow>(`SELECT id FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(row?.id).toBe(jobId)
  })

  test('dispatch inside a rolled-back UnitOfWork.run drops the row', async () => {
    const uow = new UnitOfWork(db, new EventBus())
    let jobId = ''
    await expect(
      uow.run(async () => {
        jobId = await queue.dispatch(TestJob, { note: 'will-roll-back' })
        throw new Error('user-rollback')
      }),
    ).rejects.toThrow(/user-rollback/)
    expect(jobId).not.toBe('') // dispatch did assign + return a jobId before the throw
    // The row never committed — selecting from outside the tx finds nothing.
    const row = await db.queryOne<JobRow>(`SELECT id FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(row).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Worker — claim + run + DELETE / retry round-trip
  // ───────────────────────────────────────────────────────────────────────────

  test('Worker.processOne claims via SKIP LOCKED, runs handle, DELETEs on success', async () => {
    const runs: Array<{ note: string; attempt: number }> = []
    class SuccessfulJob extends Job<{ note: string }> {
      static override readonly jobName = 'integration.worker-success'
      async handle(ctx: JobContext<{ note: string }>): Promise<void> {
        runs.push({ note: ctx.payload.note, attempt: ctx.attempt })
      }
    }

    const jobId = await queue.dispatch(SuccessfulJob, { note: 'worker-claim' })

    const registry = new JobRegistry().register(SuccessfulJob)
    const worker = new Worker({
      db,
      registry,
      container: new Application(),
      queues: ['default'],
    })

    const result = await worker.processOne()
    expect(result?.status).toBe('completed')
    expect(result?.jobId).toBe(jobId)
    expect(runs).toEqual([{ note: 'worker-claim', attempt: 1 }])

    // Row should be gone after a successful claim+run+delete cycle.
    const row = await db.queryOne(`SELECT id FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(row).toBeNull()
  })

  test('Worker.processOne on a failing job reschedules with backoff', async () => {
    const failures: Array<{ attempt: number; error: string }> = []
    class TransientJob extends Job<unknown> {
      static override readonly jobName = 'integration.worker-transient'
      static override readonly maxAttempts = 3
      static override readonly backoff = (_attempt: number) => 30
      async handle(): Promise<void> {
        throw new Error('transient flake')
      }
      override async failed(ctx: JobFailedContext<unknown>): Promise<void> {
        failures.push({ attempt: ctx.attempt, error: (ctx.error as Error).message })
      }
    }

    const jobId = await queue.dispatch(TransientJob, {})

    const registry = new JobRegistry().register(TransientJob)
    const worker = new Worker({
      db,
      registry,
      container: new Application(),
      queues: ['default'],
    })

    const result = await worker.processOne()
    expect(result?.status).toBe('retried')
    expect(failures).toEqual([{ attempt: 1, error: 'transient flake' }])

    // Row still present + rescheduled into the future.
    const row = await db.queryOne<{
      attempts: number
      reserved_at: Date | null
      available_at: Date
    }>(`SELECT attempts, reserved_at, available_at FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(row).not.toBeNull()
    expect(Number(row?.attempts)).toBe(1)
    expect(row?.reserved_at).toBeNull()
    expect(row?.available_at.getTime()).toBeGreaterThan(Date.now())

    // Clean up so subsequent tests start fresh.
    await db.execute(`DELETE FROM "strav_jobs" WHERE id = $1`, [jobId])
  })

  test('Worker terminal failure atomically moves the row to strav_failed_jobs', async () => {
    class AlwaysFailingIntegrationJob extends Job<{ note: string }> {
      static override readonly jobName = 'integration.always-failing'
      static override readonly maxAttempts = 1
      async handle(): Promise<void> {
        throw new Error('always fails — terminal')
      }
    }
    const jobId = await queue.dispatch(AlwaysFailingIntegrationJob, { note: 'goodbye' })

    const registry = new JobRegistry().register(AlwaysFailingIntegrationJob)
    const worker = new Worker({
      db,
      registry,
      container: new Application(),
      queues: ['default'],
    })
    const result = await worker.processOne()
    expect(result?.status).toBe('failed')

    // Original row is gone.
    const jobRow = await db.queryOne(`SELECT id FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(jobRow).toBeNull()

    // New failed_jobs row exists with the captured fields.
    const failed = await db.queryOne<{
      queue: string
      job_name: string
      payload: { note: string }
      exception: string
      attempts: number
      failed_at: Date
    }>(
      `SELECT queue, job_name, payload, exception, attempts, failed_at
       FROM "strav_failed_jobs"
       WHERE job_name = $1`,
      ['integration.always-failing'],
    )
    expect(failed).not.toBeNull()
    expect(failed?.queue).toBe('default')
    expect(failed?.payload).toEqual({ note: 'goodbye' })
    expect(failed?.exception).toContain('always fails')
    expect(Number(failed?.attempts)).toBe(1)
    expect(failed?.failed_at.getTime()).toBeLessThanOrEqual(Date.now())

    // Clean up.
    await db.execute(`DELETE FROM "strav_failed_jobs" WHERE job_name = $1`, [
      'integration.always-failing',
    ])
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Scheduler — cron-driven dispatch + onOneServer advisory lock
  // ───────────────────────────────────────────────────────────────────────────

  test('Scheduler.tick with oneServer dispatches once + records the run', async () => {
    class ScheduledJob extends Job<unknown> {
      static override readonly jobName = 'integration.scheduled-once'
      async handle(): Promise<void> {}
    }
    const tenants = new TenantManager(db, new EventBus())
    const scheduler = new Scheduler({ queue, tenants })
    scheduler.schedule({
      job: ScheduledJob,
      cron: everyMinute(),
      name: 'integration:scheduled-once',
      oneServer: true,
    })

    const tickAt = new Date('2026-05-28T10:30:00Z')
    await scheduler.tick(tickAt)

    // One queue row for the job exists.
    const rows = await db.query<{ id: string }>(`SELECT id FROM "strav_jobs" WHERE job_name = $1`, [
      'integration.scheduled-once',
    ])
    expect(rows).toHaveLength(1)

    // strav_scheduler_runs records the tick boundary.
    const run = await db.queryOne<{ name: string; last_run_at: Date }>(
      `SELECT name, last_run_at FROM "strav_scheduler_runs" WHERE name = $1`,
      ['integration:scheduled-once'],
    )
    expect(run?.last_run_at.toISOString()).toBe(tickAt.toISOString())

    // A second tick at the SAME boundary on a "different server" skips:
    // emulate that by running another Scheduler instance + tick. The lock
    // sees last_run_at >= boundary and returns without dispatching.
    const scheduler2 = new Scheduler({ queue, tenants })
    scheduler2.schedule({
      job: ScheduledJob,
      cron: everyMinute(),
      name: 'integration:scheduled-once',
      oneServer: true,
    })
    await scheduler2.tick(tickAt)
    const rowsAfter = await db.query<{ id: string }>(
      `SELECT id FROM "strav_jobs" WHERE job_name = $1`,
      ['integration.scheduled-once'],
    )
    expect(rowsAfter).toHaveLength(1) // still just the one — second tick skipped

    // Clean up.
    await db.execute(`DELETE FROM "strav_jobs" WHERE job_name = $1`, ['integration.scheduled-once'])
    await db.execute(`DELETE FROM "strav_scheduler_runs" WHERE name = $1`, [
      'integration:scheduled-once',
    ])
  })
})

describe.skipIf(PG_AVAILABLE)(
  'integration: @strav/queue DatabaseQueue smoke (skipped — no DB)',
  () => {
    test('queue integration tests skipped — set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE or run docker-compose', () => {
      expect(true).toBe(true)
    })
  },
)
