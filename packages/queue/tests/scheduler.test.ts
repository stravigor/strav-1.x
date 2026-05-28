import { beforeEach, describe, expect, test } from 'bun:test'
import type { DatabaseExecutor, TenantManager } from '@strav/database'
import {
  cron,
  daily,
  everyMinute,
  hourly,
  Job,
  type JobClass,
  type JobContext,
  type Queue,
  Scheduler,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// FakeQueue — records every dispatch.
// ─────────────────────────────────────────────────────────────────────────────

interface DispatchCall {
  jobName: string
  payload: unknown
}

class FakeQueue {
  readonly dispatches: DispatchCall[] = []
  async dispatch(job: JobClass, payload: unknown): Promise<string> {
    this.dispatches.push({ jobName: job.jobName, payload })
    return 'fake-job-id'
  }
  async dispatchLater() {
    throw new Error('not used in scheduler tests')
  }
  async dispatchSync() {
    throw new Error('not used in scheduler tests')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FakeTenantManager — scripts the withLock callback so we can test the
// onOneServer path without standing up a real Postgres.
// ─────────────────────────────────────────────────────────────────────────────

class FakeTenantManager {
  /** Latest `last_run_at` value the FakeTx will return from SELECT. */
  lastRunAt: Date | null = null
  /** Records every SQL call routed through the fake tx during withLock. */
  readonly txCalls: Array<{ sql: string; params: readonly unknown[] }> = []
  /** Records every lock key passed to withLock — for assertion on the lock name. */
  readonly lockKeys: string[] = []

  async withLock<T>(lockKey: string, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    this.lockKeys.push(lockKey)
    const tx: DatabaseExecutor = {
      query: async () => [],
      queryOne: async <U>(sql: string, params: readonly unknown[] = []) => {
        this.txCalls.push({ sql, params })
        if (sql.includes('SELECT last_run_at')) {
          return this.lastRunAt === null
            ? (null as U | null)
            : ({ last_run_at: this.lastRunAt } as unknown as U)
        }
        return null as U | null
      },
      execute: async (sql, params = []) => {
        this.txCalls.push({ sql, params })
        return 1
      },
    }
    return fn(tx)
  }

  // The Scheduler only uses `withLock`. Stub the rest of the surface as a
  // type-compat satisfier so we can pass this fake where a TenantManager is
  // expected.
  async withTenant() {
    throw new Error('not used in scheduler tests')
  }
  async withoutTenant() {
    throw new Error('not used in scheduler tests')
  }
  async withTenantLock() {
    throw new Error('not used in scheduler tests')
  }
  currentTenantId() {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

class FixtureJob extends Job<{ note: string }> {
  static override readonly jobName = 'scheduler.fixture'
  async handle(_ctx: JobContext<{ note: string }>): Promise<void> {}
}

class SecondJob extends Job<unknown> {
  static override readonly jobName = 'scheduler.second'
  async handle(): Promise<void> {}
}

function makeScheduler() {
  const queue = new FakeQueue()
  const tenants = new FakeTenantManager()
  const scheduler = new Scheduler({
    queue: queue as unknown as Queue,
    tenants: tenants as unknown as TenantManager,
  })
  return { queue, tenants, scheduler }
}

beforeEach(() => {
  // Each test re-creates its own scheduler, but a global reset hook keeps
  // future additions easy.
})

// ─────────────────────────────────────────────────────────────────────────────
// schedule + all
// ─────────────────────────────────────────────────────────────────────────────

describe('Scheduler — schedule registration', () => {
  test('schedule returns `this` for chaining', () => {
    const { scheduler } = makeScheduler()
    expect(scheduler.schedule({ job: FixtureJob, cron: hourly() })).toBe(scheduler)
  })

  test('entry defaults: name = job.jobName, oneServer = false, payload = undefined', () => {
    const { scheduler } = makeScheduler()
    scheduler.schedule({ job: FixtureJob, cron: hourly() })
    const [entry] = scheduler.all()
    expect(entry?.name).toBe('scheduler.fixture')
    expect(entry?.oneServer).toBe(false)
    expect(entry?.payload).toBeUndefined()
  })

  test('overrides flow through to the entry', () => {
    const { scheduler } = makeScheduler()
    scheduler.schedule({
      job: FixtureJob,
      cron: daily(),
      name: 'midnight-cleanup',
      payload: { tag: 'x' },
      oneServer: true,
    })
    const [entry] = scheduler.all()
    expect(entry?.name).toBe('midnight-cleanup')
    expect(entry?.oneServer).toBe(true)
    expect(entry?.payload).toEqual({ tag: 'x' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tick — dispatch when cron matches
// ─────────────────────────────────────────────────────────────────────────────

describe('Scheduler — tick (no oneServer)', () => {
  test('dispatches entries whose cron matches the tick boundary', async () => {
    const { queue, scheduler } = makeScheduler()
    scheduler.schedule({ job: FixtureJob, cron: everyMinute() })
    scheduler.schedule({ job: SecondJob, cron: cron('30 * * * *') })

    await scheduler.tick(new Date('2026-05-28T10:30:00Z'))
    const names = queue.dispatches.map((d) => d.jobName).sort()
    expect(names).toEqual(['scheduler.fixture', 'scheduler.second'])
  })

  test('skips entries whose cron does not match', async () => {
    const { queue, scheduler } = makeScheduler()
    scheduler.schedule({ job: FixtureJob, cron: cron('30 * * * *') })
    await scheduler.tick(new Date('2026-05-28T10:00:00Z'))
    expect(queue.dispatches).toHaveLength(0)
  })

  test('floors the supplied date to the minute boundary', async () => {
    const { queue, scheduler } = makeScheduler()
    // Match minute=15. Supply a date with seconds + millis to make sure
    // the Scheduler floors before matching.
    scheduler.schedule({ job: FixtureJob, cron: cron('15 * * * *') })
    await scheduler.tick(new Date('2026-05-28T10:15:42.387Z'))
    expect(queue.dispatches).toHaveLength(1)
  })

  test('a throw from one dispatch does not block the others', async () => {
    const { queue } = makeScheduler()
    // Patch the FakeQueue to throw on the first dispatch.
    let calls = 0
    const queueWithThrow = {
      ...queue,
      dispatch: async (job: JobClass, payload: unknown) => {
        calls++
        if (calls === 1) throw new Error('first dispatch fails')
        queue.dispatches.push({ jobName: job.jobName, payload })
        return 'id'
      },
    }
    const tenants = new FakeTenantManager()
    const scheduler2 = new Scheduler({
      queue: queueWithThrow as unknown as Queue,
      tenants: tenants as unknown as TenantManager,
    })
    scheduler2.schedule({ job: FixtureJob, cron: everyMinute() })
    scheduler2.schedule({ job: SecondJob, cron: everyMinute() })
    await scheduler2.tick(new Date('2026-05-28T10:30:00Z'))
    // FixtureJob's dispatch threw; SecondJob's succeeded.
    expect(queue.dispatches.map((d) => d.jobName)).toEqual(['scheduler.second'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tick — oneServer (advisory lock + run-tracking)
// ─────────────────────────────────────────────────────────────────────────────

describe('Scheduler — tick (oneServer)', () => {
  test('routes the dispatch through withLock with the right lock key', async () => {
    const { queue, tenants, scheduler } = makeScheduler()
    scheduler.schedule({
      job: FixtureJob,
      cron: everyMinute(),
      name: 'special',
      oneServer: true,
    })
    await scheduler.tick(new Date('2026-05-28T10:30:00Z'))
    expect(tenants.lockKeys).toEqual(['scheduler:special'])
    expect(queue.dispatches).toHaveLength(1)
  })

  test('reads strav_scheduler_runs.last_run_at + UPSERTs after dispatch', async () => {
    const { tenants, scheduler } = makeScheduler()
    scheduler.schedule({ job: FixtureJob, cron: everyMinute(), oneServer: true })
    await scheduler.tick(new Date('2026-05-28T10:30:00Z'))
    const select = tenants.txCalls.find((c) => c.sql.includes('SELECT last_run_at'))
    const upsert = tenants.txCalls.find(
      (c) => c.sql.includes('INSERT INTO "strav_scheduler_runs"') && c.sql.includes('ON CONFLICT'),
    )
    expect(select?.params).toEqual(['scheduler.fixture'])
    expect(upsert?.params[1]).toBe('scheduler.fixture')
    // last_run_at param is the floored tick boundary.
    expect((upsert?.params[2] as Date).toISOString()).toBe('2026-05-28T10:30:00.000Z')
  })

  test('skips dispatch when last_run_at >= tick boundary (another server won)', async () => {
    const { queue, tenants, scheduler } = makeScheduler()
    tenants.lastRunAt = new Date('2026-05-28T10:30:00.000Z') // same tick as below
    scheduler.schedule({ job: FixtureJob, cron: everyMinute(), oneServer: true })
    await scheduler.tick(new Date('2026-05-28T10:30:00Z'))
    expect(queue.dispatches).toHaveLength(0)
    // We DID enter the lock + SELECT, just didn't UPSERT/dispatch.
    expect(tenants.txCalls.find((c) => c.sql.includes('SELECT'))).toBeDefined()
    expect(tenants.txCalls.find((c) => c.sql.includes('INSERT INTO'))).toBeUndefined()
  })

  test('proceeds when last_run_at < tick boundary (a previous run, not this one)', async () => {
    const { queue, tenants, scheduler } = makeScheduler()
    tenants.lastRunAt = new Date('2026-05-28T10:29:00.000Z') // previous minute
    scheduler.schedule({ job: FixtureJob, cron: everyMinute(), oneServer: true })
    await scheduler.tick(new Date('2026-05-28T10:30:00Z'))
    expect(queue.dispatches).toHaveLength(1)
  })

  test('defaults to job.jobName when no `name` is supplied', async () => {
    const { tenants, scheduler } = makeScheduler()
    scheduler.schedule({ job: SecondJob, cron: everyMinute(), oneServer: true })
    await scheduler.tick(new Date('2026-05-28T10:30:00Z'))
    expect(tenants.lockKeys).toEqual(['scheduler:scheduler.second'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// run — minute loop + graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe('Scheduler — run (minute loop)', () => {
  test('exits within one tick of an abort signal', async () => {
    const { scheduler } = makeScheduler()
    // No schedules — run loop just sleeps until the next minute or abort.
    const controller = new AbortController()
    const runPromise = scheduler.run(controller.signal)
    // Give the loop a moment to enter its first sleep.
    await new Promise<void>((r) => setTimeout(r, 30))
    const start = Date.now()
    controller.abort()
    await runPromise
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })
})
