/**
 * Unit tests for the queue console commands. The Worker / Scheduler / DB
 * are all stubbed; we're testing argv binding, output, and the orchestration
 * — actual queue semantics are covered by the queue's existing unit tests.
 */

import { describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor, TenantManager } from '@strav/database'
import { PostgresDatabase } from '@strav/database'
import { Application, type CommandContext, ConsoleOutput } from '@strav/kernel'
import { QueueFailed } from '../../src/console/queue_failed.ts'
import { QueueFlush } from '../../src/console/queue_flush.ts'
import { QueueRetry } from '../../src/console/queue_retry.ts'
import { QueueWork } from '../../src/console/queue_work.ts'
import { SchedulerList } from '../../src/console/scheduler_list.ts'
import { SchedulerRun } from '../../src/console/scheduler_run.ts'
import { cron, Job, type JobContext, type Queue, Scheduler, Worker } from '../../src/index.ts'

class MemStream {
  chunks: string[] = []
  write(c: string): boolean {
    this.chunks.push(c)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

/** Tiny Database stub — enough for the commands to query / execute / transaction. */
class FakeDb implements Database {
  readonly queries: { sql: string; params: readonly unknown[] }[] = []
  readonly executed: { sql: string; params: readonly unknown[] }[] = []
  rowsByPattern: { pattern: RegExp; rows: unknown[] }[] = []
  deleteCount = 1

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    this.queries.push({ sql, params })
    for (const entry of this.rowsByPattern) {
      if (entry.pattern.test(sql)) return entry.rows as T[]
    }
    return []
  }
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.executed.push({ sql, params })
    return this.deleteCount
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn({
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: this.execute.bind(this),
    })
  }
  async close(): Promise<void> {}
  raw(): never {
    throw new Error('not used')
  }
}

function buildCtx(app: Application): {
  ctx: (args?: string[], flags?: Record<string, string | boolean>) => CommandContext
  stdout: MemStream
  stderr: MemStream
} {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx = (
    args: string[] = [],
    flags: Record<string, string | boolean> = {},
  ): CommandContext => ({
    args,
    flags,
    out,
    app,
  })
  return { ctx, stdout, stderr }
}

// ─────────────────────────────────────────────────────────────────────────────
// queue:work
// ─────────────────────────────────────────────────────────────────────────────

describe('queue:work', () => {
  test('--max=N exits after N processed jobs', async () => {
    let processed = 0
    const worker = {
      async processOne() {
        processed++
        return processed <= 2
          ? {
              status: 'completed' as const,
              jobId: `j${processed}`,
              jobName: 'fixture',
              attempts: 1,
            }
          : null
      },
      async run() {
        throw new Error('should not call run() when --max is set')
      },
    }
    const app = new Application()
    app.singleton(Worker, () => worker as unknown as Worker)
    const env = buildCtx(app)
    const exit = await new QueueWork().handle(env.ctx([], { queue: 'default', max: '2' }))
    expect(exit).toBe(0)
    expect(processed).toBe(2)
    expect(env.stdout.text()).toContain('Stopped after 2 job(s).')
  })

  test('--max=not-a-number → exit 2', async () => {
    const worker = {
      async processOne() {
        return null
      },
      async run() {},
    }
    const app = new Application()
    app.singleton(Worker, () => worker as unknown as Worker)
    const env = buildCtx(app)
    const exit = await new QueueWork().handle(env.ctx([], { max: 'oops' }))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('--max must be a positive integer')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// queue:failed
// ─────────────────────────────────────────────────────────────────────────────

describe('queue:failed', () => {
  test('prints a table of failed rows', async () => {
    const db = new FakeDb()
    db.rowsByPattern.push({
      pattern: /strav_failed_jobs/,
      rows: [
        {
          id: '01HK',
          queue: 'default',
          job_name: 'send.welcome',
          attempts: 3,
          failed_at: new Date('2026-05-29T10:00:00Z'),
          exception: 'Network timeout\n  at fetch (...)',
        },
      ],
    })
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueFailed().handle(env.ctx())
    expect(exit).toBe(0)
    const text = env.stdout.text()
    expect(text).toContain('send.welcome')
    expect(text).toContain('Network timeout')
    expect(text).not.toContain('at fetch') // first-line trim
  })

  test('"No failed jobs." when empty', async () => {
    const db = new FakeDb()
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueFailed().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No failed jobs.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// queue:retry
// ─────────────────────────────────────────────────────────────────────────────

describe('queue:retry', () => {
  test('requires <id> or --all', async () => {
    const app = new Application()
    app.singleton(PostgresDatabase, () => new FakeDb() as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueRetry().handle(env.ctx())
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('queue:retry needs an <id> or the --all flag')
  })

  test('--all moves every failed row into strav_jobs', async () => {
    const db = new FakeDb()
    db.rowsByPattern.push({
      pattern: /FROM "strav_failed_jobs"$/,
      rows: [
        { id: 'f1', queue: 'default', job_name: 'a', payload: {} },
        { id: 'f2', queue: 'mail', job_name: 'b', payload: { to: 'x@y' } },
      ],
    })
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueRetry().handle(env.ctx([], { all: true }))
    expect(exit).toBe(0)
    const inserts = db.executed.filter((e) => e.sql.includes('INSERT INTO "strav_jobs"'))
    const deletes = db.executed.filter((e) => e.sql.includes('DELETE FROM "strav_failed_jobs"'))
    expect(inserts).toHaveLength(2)
    expect(deletes).toHaveLength(2)
    expect(env.stdout.text()).toContain('Re-enqueued 2 job(s).')
  })

  test('passing an unknown id reports "No failed job with id"', async () => {
    const db = new FakeDb()
    // No row matches.
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueRetry().handle(env.ctx(['missing']))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No failed job with id "missing".')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// queue:flush
// ─────────────────────────────────────────────────────────────────────────────

describe('queue:flush', () => {
  test('--force deletes without prompting', async () => {
    const db = new FakeDb()
    db.deleteCount = 7
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueFlush().handle(env.ctx([], { force: true }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Deleted 7 pending job(s)')
    expect(db.executed[0]?.sql).toBe('DELETE FROM "strav_jobs"')
  })

  test('--queue=mail scopes the delete', async () => {
    const db = new FakeDb()
    db.deleteCount = 3
    const app = new Application()
    app.singleton(PostgresDatabase, () => db as unknown as PostgresDatabase)
    const env = buildCtx(app)
    const exit = await new QueueFlush().handle(env.ctx([], { force: true, queue: 'mail' }))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('from queue "mail"')
    expect(db.executed[0]?.sql).toBe('DELETE FROM "strav_jobs" WHERE queue = $1')
    expect(db.executed[0]?.params).toEqual(['mail'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// scheduler:list + scheduler:run
// ─────────────────────────────────────────────────────────────────────────────

class FakeQueue {
  readonly dispatches: { jobName: string }[] = []
  async dispatch(job: { jobName: string }): Promise<string> {
    this.dispatches.push({ jobName: job.jobName })
    return 'fake-id'
  }
  async dispatchLater(): Promise<string> {
    return 'fake-id'
  }
  async dispatchSync(): Promise<void> {}
}

class FakeTenants {
  async withLock<T>(_k: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  }
  async withTenant(): Promise<never> {
    throw new Error('not used')
  }
  async withoutTenant(): Promise<never> {
    throw new Error('not used')
  }
  async withTenantLock(): Promise<never> {
    throw new Error('not used')
  }
  currentTenantId() {
    return null
  }
}

class FixtureJob extends Job<unknown> {
  static override readonly jobName = 'scheduler.fixture'
  async handle(_ctx: JobContext<unknown>): Promise<void> {}
}

function makeScheduler(): Scheduler {
  const scheduler = new Scheduler({
    queue: new FakeQueue() as unknown as Queue,
    tenants: new FakeTenants() as unknown as TenantManager,
  })
  scheduler.schedule({ job: FixtureJob, cron: cron('*/5 * * * *') })
  return scheduler
}

describe('scheduler:list', () => {
  test('prints a table of registered entries', async () => {
    const scheduler = makeScheduler()
    const app = new Application()
    app.singleton(Scheduler, () => scheduler)
    const env = buildCtx(app)
    const exit = await new SchedulerList().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('scheduler.fixture')
    expect(env.stdout.text()).toContain('*/5 * * * *')
  })

  test('empty state prints "No schedules registered."', async () => {
    const scheduler = new Scheduler({
      queue: new FakeQueue() as unknown as Queue,
      tenants: new FakeTenants() as unknown as TenantManager,
    })
    const app = new Application()
    app.singleton(Scheduler, () => scheduler)
    const env = buildCtx(app)
    const exit = await new SchedulerList().handle(env.ctx())
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('No schedules registered.')
  })
})

describe('scheduler:run', () => {
  test('dispatches the named entry', async () => {
    const scheduler = makeScheduler()
    const app = new Application()
    app.singleton(Scheduler, () => scheduler)
    const env = buildCtx(app)
    const exit = await new SchedulerRun().handle(env.ctx(['scheduler.fixture']))
    expect(exit).toBe(0)
    expect(env.stdout.text()).toContain('Dispatched "scheduler.fixture".')
  })

  test('unknown name → exit 2 + stderr', async () => {
    const scheduler = makeScheduler()
    const app = new Application()
    app.singleton(Scheduler, () => scheduler)
    const env = buildCtx(app)
    const exit = await new SchedulerRun().handle(env.ctx(['no-such']))
    expect(exit).toBe(2)
    expect(env.stderr.text()).toContain('no schedule with that name registered')
  })
})
