import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor } from '@strav/database'
import { Application } from '@strav/kernel'
import { Job, type JobContext, type JobFailedContext, JobRegistry, Worker } from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// FakeDb — scripts queryOne responses for SELECT, records every call
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  sql: string
  params: readonly unknown[]
  inTransaction: boolean
}

interface JobRow {
  id: string
  queue: string
  job_name: string
  payload: unknown
  attempts: number
  max_attempts: number
}

class FakeDb implements Database {
  readonly calls: Call[] = []
  /**
   * Queue of rows to return from `SELECT ... FOR UPDATE SKIP LOCKED`.
   * Each `claim()` call dequeues one. Empty queue → `null`.
   */
  scriptedRows: Array<JobRow | null> = []

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
        // Worker's claim issues a SELECT ... FOR UPDATE SKIP LOCKED.
        // Pop from scriptedRows for that path; everything else returns null.
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          const row = this.scriptedRows.shift() ?? null
          return row as U | null
        }
        return null
      },
      execute: async (sql, params = []) => {
        this.calls.push({ sql, params, inTransaction: true })
        return 1
      },
    }
    return fn(tx)
  }
  async close(): Promise<void> {}
  raw(): never {
    throw new Error('FakeDb.raw not implemented')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface RunRecord {
  handles: Array<{ ctx: JobContext<unknown> }>
  failures: Array<{ ctx: JobFailedContext<unknown> }>
}

const records = new Map<string, RunRecord>()

function recordOf(jobName: string): RunRecord {
  let r = records.get(jobName)
  if (!r) {
    r = { handles: [], failures: [] }
    records.set(jobName, r)
  }
  return r
}

class SuccessJob extends Job<{ note: string }> {
  static override readonly jobName = 'test.success'
  async handle(ctx: JobContext<{ note: string }>): Promise<void> {
    recordOf('test.success').handles.push({ ctx })
  }
}

class AlwaysFailingJob extends Job<{ note: string }> {
  static override readonly jobName = 'test.always-failing'
  static override readonly maxAttempts = 3
  static override readonly backoff = (_attempt: number) => 5
  async handle(ctx: JobContext<{ note: string }>): Promise<void> {
    recordOf('test.always-failing').handles.push({ ctx })
    throw new Error('always fails')
  }
  override async failed(ctx: JobFailedContext<{ note: string }>): Promise<void> {
    recordOf('test.always-failing').failures.push({ ctx })
  }
}

class HookThrowsJob extends Job<unknown> {
  static override readonly jobName = 'test.hook-throws'
  static override readonly maxAttempts = 2
  async handle(): Promise<void> {
    throw new Error('handle failure')
  }
  override async failed(): Promise<void> {
    throw new Error('hook also fails')
  }
}

class SlowJob extends Job<unknown> {
  static override readonly jobName = 'test.slow'
  static override readonly timeout = 0.05 // 50ms
  static override readonly maxAttempts = 1
  async handle(ctx: JobContext<unknown>): Promise<void> {
    // Wait for the abort signal — handlers that loop should do this in real code.
    await new Promise<void>((resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      // Long sleep — abort fires first.
      setTimeout(resolve, 1000)
    })
  }
}

function makeWorker(db: FakeDb, registry: JobRegistry) {
  return new Worker({
    db,
    registry,
    container: new Application(),
    queues: ['default'],
    pollInterval: 10,
    timeoutSeconds: 30,
  })
}

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: '01HZ80000000000000000000A1',
    queue: 'default',
    job_name: 'test.success',
    payload: { note: 'hello' },
    attempts: 0,
    max_attempts: 3,
    ...overrides,
  }
}

beforeEach(() => {
  records.clear()
})

// ─────────────────────────────────────────────────────────────────────────────
// processOne — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('Worker — processOne (success)', () => {
  test('returns null when the queue has no available rows', async () => {
    const db = new FakeDb()
    db.scriptedRows = [null]
    const registry = new JobRegistry().register(SuccessJob)
    const result = await makeWorker(db, registry).processOne()
    expect(result).toBeNull()
  })

  test('claims via SELECT FOR UPDATE SKIP LOCKED + increments attempts in the same tx', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row()]
    const registry = new JobRegistry().register(SuccessJob)
    await makeWorker(db, registry).processOne()
    const claim = db.calls.find((c) => c.sql.includes('FOR UPDATE SKIP LOCKED'))
    const update = db.calls.find(
      (c) => c.sql.includes('UPDATE') && c.sql.includes('attempts = attempts + 1'),
    )
    expect(claim?.inTransaction).toBe(true)
    expect(update?.inTransaction).toBe(true)
  })

  test('runs handle() with attempt = 1 (the incremented value)', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row({ attempts: 0 })]
    const registry = new JobRegistry().register(SuccessJob)
    await makeWorker(db, registry).processOne()
    const rec = recordOf('test.success')
    expect(rec.handles).toHaveLength(1)
    expect(rec.handles[0]?.ctx.attempt).toBe(1)
    expect(rec.handles[0]?.ctx.payload).toEqual({ note: 'hello' })
  })

  test('DELETEs the row on success + returns status:completed', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row()]
    const registry = new JobRegistry().register(SuccessJob)
    const result = await makeWorker(db, registry).processOne()
    expect(result?.status).toBe('completed')
    expect(result?.jobId).toBe('01HZ80000000000000000000A1')
    const deletes = db.calls.filter((c) => c.sql.startsWith('DELETE FROM "strav_jobs"'))
    expect(deletes).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// processOne — failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe('Worker — processOne (failure with retry)', () => {
  test('on transient failure, reschedules with backoff + returns status:retried', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row({ job_name: 'test.always-failing', attempts: 0 })]
    const registry = new JobRegistry().register(AlwaysFailingJob)
    const result = await makeWorker(db, registry).processOne()
    expect(result?.status).toBe('retried')
    expect(result?.attempts).toBe(1)
    const update = db.calls.find(
      (c) =>
        c.sql.includes('UPDATE') &&
        c.sql.includes('available_at = now()') &&
        c.sql.includes('reserved_at = NULL'),
    )
    expect(update).toBeDefined()
    // Backoff was 5s (per AlwaysFailingJob.backoff()).
    expect(update?.sql).toContain(`interval '5 seconds'`)
  })

  test('runs the failed() hook on each failure', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row({ job_name: 'test.always-failing', attempts: 0 })]
    const registry = new JobRegistry().register(AlwaysFailingJob)
    await makeWorker(db, registry).processOne()
    const rec = recordOf('test.always-failing')
    expect(rec.failures).toHaveLength(1)
    expect((rec.failures[0]?.ctx.error as Error).message).toBe('always fails')
  })

  test('terminates after maxAttempts — DELETE + status:failed', async () => {
    const db = new FakeDb()
    // Row already at attempts=2 (the previous attempts). Worker increments
    // to 3, runs handle, fails. attempts=3 >= maxAttempts=3 → terminal.
    db.scriptedRows = [row({ job_name: 'test.always-failing', attempts: 2 })]
    const registry = new JobRegistry().register(AlwaysFailingJob)
    const result = await makeWorker(db, registry).processOne()
    expect(result?.status).toBe('failed')
    expect(result?.attempts).toBe(3)
    const deletes = db.calls.filter((c) => c.sql.startsWith('DELETE FROM "strav_jobs"'))
    expect(deletes).toHaveLength(1)
  })

  test('failed() hook throwing does not change the retry decision', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row({ job_name: 'test.hook-throws', attempts: 0 })]
    const registry = new JobRegistry().register(HookThrowsJob)
    const result = await makeWorker(db, registry).processOne()
    // Still retried — hook throw is logged, not propagated.
    expect(result?.status).toBe('retried')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// processOne — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Worker — processOne (edge cases)', () => {
  test('unknown job_name → DELETE + status:failed (queue not blocked)', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row({ job_name: 'test.unregistered' })]
    const registry = new JobRegistry().register(SuccessJob)
    const result = await makeWorker(db, registry).processOne()
    expect(result?.status).toBe('failed')
    const deletes = db.calls.filter((c) => c.sql.startsWith('DELETE FROM "strav_jobs"'))
    expect(deletes).toHaveLength(1)
  })

  test('per-attempt timeout aborts the handler and counts as a failure', async () => {
    const db = new FakeDb()
    db.scriptedRows = [row({ job_name: 'test.slow', attempts: 0 })]
    const registry = new JobRegistry().register(SlowJob)
    const result = await makeWorker(db, registry).processOne()
    // SlowJob.maxAttempts = 1, so this is a terminal failure.
    expect(result?.status).toBe('failed')
  }, 1000)
})

// ─────────────────────────────────────────────────────────────────────────────
// run — poll loop + graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe('Worker — run (poll loop)', () => {
  test('processes available rows then sleeps on empty', async () => {
    const db = new FakeDb()
    // Two rows, then queue empty.
    db.scriptedRows = [
      row({ id: '01HZ80000000000000000000B1' }),
      row({ id: '01HZ80000000000000000000B2' }),
      null,
    ]
    const registry = new JobRegistry().register(SuccessJob)
    const worker = makeWorker(db, registry)
    const controller = new AbortController()
    const runPromise = worker.run(controller.signal)
    // Wait until both rows are processed (DELETEs hit the call log).
    await waitFor(() => {
      const deletes = db.calls.filter((c) => c.sql.startsWith('DELETE FROM "strav_jobs"'))
      return deletes.length >= 2
    })
    controller.abort()
    await runPromise
    const handles = recordOf('test.success').handles
    expect(handles).toHaveLength(2)
  })

  test('exits within one tick of an abort signal', async () => {
    const db = new FakeDb()
    db.scriptedRows = [null] // empty queue immediately
    const registry = new JobRegistry().register(SuccessJob)
    const worker = new Worker({
      db,
      registry,
      container: new Application(),
      queues: ['default'],
      pollInterval: 5000, // long sleep — but abort short-circuits it
      timeoutSeconds: 30,
    })
    const controller = new AbortController()
    const start = Date.now()
    const runPromise = worker.run(controller.signal)
    // Give the loop one tick to start its sleep, then abort.
    await new Promise<void>((r) => setTimeout(r, 20))
    controller.abort()
    await runPromise
    const elapsed = Date.now() - start
    // Should exit well under the pollInterval (5s).
    expect(elapsed).toBeLessThan(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`)
    }
    await new Promise<void>((r) => setTimeout(r, 10))
  }
}
