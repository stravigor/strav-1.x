import { beforeEach, describe, expect, test } from 'bun:test'
import { Application, inject, isUlid } from '@strav/kernel'
import { Job, type JobContext, SyncQueue } from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State-object pattern: the static `state` field is the stable
 * object reference; TS doesn't narrow it when callers mutate
 * `state.last`. Avoids the "RecorderJob.last = undefined narrows the
 * static to undefined" foot-gun.
 */
interface RecorderState {
  last: JobContext<{ message: string }> | undefined
}

class RecorderJob extends Job<{ message: string }> {
  static override readonly jobName = 'test.recorder'
  static readonly state: RecorderState = { last: undefined }

  async handle(ctx: JobContext<{ message: string }>): Promise<void> {
    RecorderJob.state.last = ctx
  }
}

class FailingJob extends Job<{ reason: string }> {
  static override readonly jobName = 'test.failing'
  async handle(ctx: JobContext<{ reason: string }>): Promise<void> {
    throw new Error(`boom: ${ctx.payload.reason}`)
  }
}

/** A Job with @inject() — proves the container is constructing instances. */
class Dependency {
  readonly tag = 'real-dependency'
}

interface DepJobState {
  lastPong: string | undefined
}

@inject()
class JobWithDep extends Job<{ ping: string }> {
  static override readonly jobName = 'test.with-dep'
  static readonly state: DepJobState = { lastPong: undefined }

  constructor(private readonly dep: Dependency) {
    super()
  }

  async handle(ctx: JobContext<{ ping: string }>): Promise<void> {
    JobWithDep.state.lastPong = `${this.dep.tag}:${ctx.payload.ping}`
  }
}

function freshApp(): Application {
  // Application's container is sufficient for SyncQueue tests — no providers
  // needed because Job subclasses get their deps via @inject() if any.
  return new Application()
}

beforeEach(() => {
  RecorderJob.state.last = undefined
  JobWithDep.state.lastPong = undefined
})

// ─────────────────────────────────────────────────────────────────────────────
// SyncQueue — dispatch / dispatchLater / dispatchSync
// ─────────────────────────────────────────────────────────────────────────────

describe('SyncQueue — dispatch', () => {
  test('runs the job synchronously and returns a ULID jobId', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    const jobId = await queue.dispatch(RecorderJob, { message: 'hello' })
    expect(typeof jobId).toBe('string')
    expect(isUlid(jobId)).toBe(true)
    const ctx = RecorderJob.state.last
    expect(ctx).toBeDefined()
    expect(ctx?.payload.message).toBe('hello')
    expect(ctx?.attempt).toBe(1)
    expect(ctx?.jobId).toBe(jobId)
  })

  test('throws propagate from handle() — no retries under SyncQueue', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    await expect(queue.dispatch(FailingJob, { reason: 'on purpose' })).rejects.toThrow(
      /boom: on purpose/,
    )
  })

  test('constructs jobs via the container so @inject() deps are wired', async () => {
    const app = freshApp()
    app.singleton(Dependency, () => new Dependency())
    const queue = new SyncQueue({ container: app })
    await queue.dispatch(JobWithDep, { ping: 'hi' })
    expect(JobWithDep.state.lastPong).toBe('real-dependency:hi')
  })
})

describe('SyncQueue — dispatchLater', () => {
  test('runs immediately (ignores delay) and returns a ULID jobId', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    const jobId = await queue.dispatchLater(60, RecorderJob, { message: 'later' })
    expect(isUlid(jobId)).toBe(true)
    expect(RecorderJob.state.last?.payload.message).toBe('later')
  })

  test('accepts a Date as the trigger time (also ignored)', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    const later = new Date(Date.now() + 60_000)
    const jobId = await queue.dispatchLater(later, RecorderJob, { message: 'date-later' })
    expect(isUlid(jobId)).toBe(true)
  })

  test('rejects a negative numeric delay (parity with DatabaseQueue contract)', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    await expect(queue.dispatchLater(-5, RecorderJob, { message: 'invalid' })).rejects.toThrow(
      /non-negative/,
    )
  })
})

describe('SyncQueue — dispatchSync', () => {
  test('runs the job synchronously and returns void', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    const result = await queue.dispatchSync(RecorderJob, { message: 'sync' })
    expect(result).toBeUndefined()
    expect(RecorderJob.state.last?.payload.message).toBe('sync')
  })

  test('handle() throws propagate', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    await expect(queue.dispatchSync(FailingJob, { reason: 'sync-throw' })).rejects.toThrow(
      /boom: sync-throw/,
    )
  })
})

describe('SyncQueue — JobContext shape', () => {
  test('every required field is populated', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    await queue.dispatchSync(RecorderJob, { message: 'inspect' })
    const ctx = RecorderJob.state.last
    expect(ctx).toBeDefined()
    expect(typeof ctx?.jobId).toBe('string')
    expect(ctx?.attempt).toBe(1)
    expect(ctx?.payload).toEqual({ message: 'inspect' })
    expect(ctx?.signal).toBeInstanceOf(AbortSignal)
    expect(ctx?.signal.aborted).toBe(false)
    expect(ctx?.log).toBeDefined()
  })

  test('default logger is a no-op (does not throw)', async () => {
    const queue = new SyncQueue({ container: freshApp() })
    await queue.dispatchSync(RecorderJob, { message: 'log-test' })
    const log = RecorderJob.state.last?.log
    expect(() => log?.info('something')).not.toThrow()
    expect(() => log?.error('boom', { code: 'x' })).not.toThrow()
  })
})
