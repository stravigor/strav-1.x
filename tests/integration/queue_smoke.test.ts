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
  UnitOfWork,
} from '../../packages/database/src/index.ts'
import { Application, EventBus } from '../../packages/kernel/src/index.ts'
import { DatabaseQueue, Job, type JobContext, jobSchema } from '../../packages/queue/src/index.ts'
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

    const registry = new SchemaRegistry().registerAll([jobSchema])
    await db.execute(emitCreateTable(jobSchema, { registry }).sql)

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
})

describe.skipIf(PG_AVAILABLE)(
  'integration: @strav/queue DatabaseQueue smoke (skipped — no DB)',
  () => {
    test('queue integration tests skipped — set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE or run docker-compose', () => {
      expect(true).toBe(true)
    })
  },
)
