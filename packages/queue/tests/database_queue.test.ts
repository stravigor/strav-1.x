import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Database, type DatabaseExecutor, UnitOfWork } from '@strav/database'
import { Application, EventBus, isUlid } from '@strav/kernel'
import { DatabaseQueue, Job, type JobContext, jobSchema } from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fake Database — records every SQL call + simulates transactions.
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  sql: string
  params: readonly unknown[]
  /** Whether this call was made inside a `db.transaction(fn)` callback. */
  inTransaction: boolean
}

class FakeDb implements Database {
  readonly calls: Call[] = []
  /** Set by tests that want the next transaction's callback to throw — simulates ROLLBACK. */
  shouldRollback = false

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, params, inTransaction: false })
    return []
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, params, inTransaction: false })
    return null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.calls.push({ sql, params, inTransaction: false })
    return 1
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    const tx: DatabaseExecutor = {
      query: async <U>(sql: string, params: readonly unknown[] = []) => {
        this.calls.push({ sql, params, inTransaction: true })
        return [] as U[]
      },
      queryOne: async <U>(sql: string, params: readonly unknown[] = []) => {
        this.calls.push({ sql, params, inTransaction: true })
        return null as U | null
      },
      execute: async (sql, params = []) => {
        this.calls.push({ sql, params, inTransaction: true })
        return 1
      },
    }
    const result = await fn(tx)
    if (this.shouldRollback) {
      this.shouldRollback = false
      throw new Error('simulated-rollback')
    }
    return result
  }
  async close(): Promise<void> {}
  raw(): never {
    throw new Error('FakeDb.raw not implemented')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

class RecorderJob extends Job<{ message: string }> {
  static override readonly jobName = 'test.recorder'
  static readonly state: { last: JobContext<{ message: string }> | undefined } = {
    last: undefined,
  }
  async handle(ctx: JobContext<{ message: string }>): Promise<void> {
    RecorderJob.state.last = ctx
  }
}

class ConfiguredJob extends Job<{ id: string }> {
  static override readonly jobName = 'test.configured'
  static override readonly queue = 'mail'
  static override readonly maxAttempts = 7
  async handle(): Promise<void> {}
}

function freshSetup() {
  const db = new FakeDb()
  const app = new Application()
  const queue = new DatabaseQueue({ db, container: app })
  return { db, app, queue }
}

beforeEach(() => {
  RecorderJob.state.last = undefined
})

afterEach(() => {
  RecorderJob.state.last = undefined
})

// ─────────────────────────────────────────────────────────────────────────────
// dispatch — INSERT row + return jobId
// ─────────────────────────────────────────────────────────────────────────────

describe('DatabaseQueue — dispatch', () => {
  test('inserts a `strav_jobs` row and returns a ULID jobId', async () => {
    const { db, queue } = freshSetup()
    const jobId = await queue.dispatch(RecorderJob, { message: 'hello' })
    expect(isUlid(jobId)).toBe(true)
    expect(db.calls).toHaveLength(1)
    const call = db.calls[0]
    expect(call?.sql).toContain('INSERT INTO "strav_jobs"')
    expect(call?.sql).toContain('available_at')
    expect(call?.sql).toContain('now()')
    expect(call?.params).toEqual([
      jobId,
      'default',
      'test.recorder',
      JSON.stringify({ message: 'hello' }),
      3, // default maxAttempts
    ])
  })

  test('honors the JobClass static queue + maxAttempts defaults', async () => {
    const { db, queue } = freshSetup()
    await queue.dispatch(ConfiguredJob, { id: 'x' })
    const params = db.calls[0]?.params as readonly unknown[]
    expect(params[1]).toBe('mail') // queue
    expect(params[4]).toBe(7) // maxAttempts
  })

  test('DispatchOptions override the JobClass static defaults', async () => {
    const { db, queue } = freshSetup()
    await queue.dispatch(ConfiguredJob, { id: 'x' }, { queue: 'priority', attempts: 1 })
    const params = db.calls[0]?.params as readonly unknown[]
    expect(params[1]).toBe('priority')
    expect(params[4]).toBe(1)
  })

  test('falls back to the constructor defaults when nothing else is set', async () => {
    const db = new FakeDb()
    const queue = new DatabaseQueue({
      db,
      container: new Application(),
      defaultQueue: 'low',
      defaultAttempts: 10,
    })
    await queue.dispatch(RecorderJob, { message: 'hi' })
    const params = db.calls[0]?.params as readonly unknown[]
    expect(params[1]).toBe('low')
    expect(params[4]).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// dispatchLater — delay flows into the available_at fragment
// ─────────────────────────────────────────────────────────────────────────────

describe('DatabaseQueue — dispatchLater', () => {
  test('emits `now() + interval N seconds` for a numeric delay', async () => {
    const { db, queue } = freshSetup()
    await queue.dispatchLater(60, RecorderJob, { message: 'soon' })
    expect(db.calls[0]?.sql).toContain(`now() + interval '60 seconds'`)
  })

  test('accepts a Date and computes the delay against the wall clock', async () => {
    const { db, queue } = freshSetup()
    const later = new Date(Date.now() + 120_000) // ~120 s from now
    await queue.dispatchLater(later, RecorderJob, { message: 'date' })
    const sql = db.calls[0]?.sql ?? ''
    // Delay should be ~120s (allow ±2 for clock skew during the test run).
    const match = sql.match(/interval '(\d+) seconds'/)
    expect(match).toBeTruthy()
    const seconds = Number(match?.[1])
    expect(seconds).toBeGreaterThanOrEqual(118)
    expect(seconds).toBeLessThanOrEqual(122)
  })

  test('Past Dates clamp to immediate (no `interval` fragment)', async () => {
    const { db, queue } = freshSetup()
    await queue.dispatchLater(new Date(Date.now() - 60_000), RecorderJob, { message: 'past' })
    const sql = db.calls[0]?.sql ?? ''
    expect(sql).toContain('now()')
    expect(sql).not.toContain('interval')
  })

  test('rejects negative numeric delays', async () => {
    const { queue } = freshSetup()
    await expect(queue.dispatchLater(-5, RecorderJob, { message: 'bad' })).rejects.toThrow(
      /non-negative/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// dispatchSync — in-process, no INSERT
// ─────────────────────────────────────────────────────────────────────────────

describe('DatabaseQueue — dispatchSync', () => {
  test('runs handle() in-process and does NOT write to the database', async () => {
    const { db, queue } = freshSetup()
    await queue.dispatchSync(RecorderJob, { message: 'sync' })
    expect(db.calls).toHaveLength(0)
    expect(RecorderJob.state.last?.payload.message).toBe('sync')
  })

  test('propagates throws from handle()', async () => {
    class FailingJob extends Job<unknown> {
      static override readonly jobName = 'test.fail'
      async handle(): Promise<void> {
        throw new Error('boom')
      }
    }
    const { queue } = freshSetup()
    await expect(queue.dispatchSync(FailingJob, {})).rejects.toThrow(/boom/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Queue-until-commit — the M3 spike
// ─────────────────────────────────────────────────────────────────────────────

describe('DatabaseQueue — queue-until-commit (via @strav/database UoW)', () => {
  test('inside UnitOfWork.run, the INSERT routes through the ambient tx', async () => {
    const { db, queue } = freshSetup()
    const uow = new UnitOfWork(db, new EventBus())
    await uow.run(async () => {
      await queue.dispatch(RecorderJob, { message: 'tx' })
    })
    // The INSERT call should be marked inTransaction:true — i.e. it
    // went through the tx executor rather than the bare db.
    const insertCall = db.calls.find((c) => c.sql.includes('INSERT INTO "strav_jobs"'))
    expect(insertCall).toBeDefined()
    expect(insertCall?.inTransaction).toBe(true)
  })

  test('on rollback, the INSERT is rolled back too (atomic with the surrounding tx)', async () => {
    const { db, queue } = freshSetup()
    const uow = new UnitOfWork(db, new EventBus())
    db.shouldRollback = true
    await expect(
      uow.run(async () => {
        await queue.dispatch(RecorderJob, { message: 'will-roll-back' })
      }),
    ).rejects.toThrow(/simulated-rollback/)
    // The INSERT *was emitted* against the tx executor — that's the
    // important contract; the real Postgres ROLLBACK would discard it.
    // What we assert here is that the dispatch DID route through the
    // tx (so atomicity holds at the DB layer), not that the FakeDb
    // un-emits calls (it doesn't simulate rollback at the SQL level).
    const insertCall = db.calls.find((c) => c.sql.includes('INSERT INTO "strav_jobs"'))
    expect(insertCall?.inTransaction).toBe(true)
  })

  test('outside any UoW scope, INSERT goes against the bare db (auto-commit)', async () => {
    const { db, queue } = freshSetup()
    await queue.dispatch(RecorderJob, { message: 'no-tx' })
    const insertCall = db.calls.find((c) => c.sql.includes('INSERT INTO "strav_jobs"'))
    expect(insertCall?.inTransaction).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// jobSchema — shape validation
// ─────────────────────────────────────────────────────────────────────────────

describe('jobSchema', () => {
  test('exposes the strav_jobs table with the expected fields', () => {
    expect(jobSchema.name).toBe('strav_jobs')
    const names = jobSchema.fields.map((f) => f.name)
    expect(names).toEqual([
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
})
