# @strav/queue

Background-job primitives for Strav 1.0 — the `Job` base class, the `JobRegistry`, the `Queue` contract, and a synchronous in-process driver. Postgres-backed `DatabaseQueue` + `Worker` + `Scheduler` land in follow-up M3 slices.

> **Status: 1.0.0-alpha — M3 in progress (contract layer + `SyncQueue` + `DatabaseQueue` (queue-until-commit) + `Worker` (SKIP LOCKED + backoff) + `Scheduler` (cron + `onOneServer`) shipped; failed-jobs table + retry to follow).**

## Install

```bash
bun add @strav/queue
```

Peer dep: `@strav/kernel` (already in the workspace).

## Defining a Job

Subclass `Job<TPayload>`, declare a stable `static jobName`, implement `handle(ctx)`:

```ts
import { Job, type JobContext } from '@strav/queue'
import { inject } from '@strav/kernel'

@inject()
export class SendWelcomeEmail extends Job<{ userId: string }> {
  static override readonly jobName = 'mail.welcome'

  constructor(
    private readonly users: UserRepository,
    private readonly mail: MailManager,
  ) {
    super()
  }

  async handle(ctx: JobContext<{ userId: string }>): Promise<void> {
    const user = await this.users.findOrFail(ctx.payload.userId)
    await this.mail.send(new WelcomeEmail(user))
  }
}
```

The Worker constructs the Job via the container — so `@inject()`-marked subclasses get their dependencies the same way Repositories + controllers do. The payload arrives on `JobContext.payload` (after JSON round-trip through the queue backend).

### Configuration

Optional static overrides — the Worker reads these per-attempt:

```ts
class SendWelcomeEmail extends Job<...> {
  static override readonly jobName = 'mail.welcome'
  static override readonly maxAttempts = 5
  static override readonly timeout = 30          // seconds
  static override readonly queue = 'mail'        // named queue
  static override backoff(attempt: number): number {
    return Math.min(60, 2 ** attempt)            // seconds before next retry
  }
}
```

Omitted fields fall back to driver defaults.

### `failed(ctx)` hook

Fires when a `handle()` attempt throws — both on intermediate retryable failures AND on the final failure. Useful for routing to a dead-letter, posting to Slack, etc.:

```ts
async failed(ctx: JobFailedContext<{ userId: string }>): Promise<void> {
  await slack.post(`Welcome email failed for ${ctx.payload.userId}: ${(ctx.error as Error).message}`)
}
```

A throw from `failed()` is logged but doesn't change the retry decision.

## Registering jobs

`JobRegistry` maps `jobName` strings back to Job classes — the Worker uses it to deserialize the queue row's `type` column into a class to instantiate.

### Explicit

```ts
import { JobRegistry } from '@strav/queue'
import { SendWelcomeEmail } from '../app/Jobs/send_welcome_email.ts'

const registry = new JobRegistry().registerAll([SendWelcomeEmail, /* ... */])
```

### Auto-discovery

`discover(pattern)` uses `Bun.Glob` to scan files, dynamically imports each, and registers every export that satisfies `isJobClass()`. Same shape as `SchemaRegistry.discover` in `@strav/database`.

```ts
await registry.discover('app/Jobs/**/*.ts')
```

Re-exports of the same class (barrel patterns) dedupe by identity; two DIFFERENT classes sharing a `jobName` throw `ConfigError`.

## Dispatching

`Queue` is an interface with three methods:

```ts
queue.dispatch(JobClass, payload, opts?)       // returns jobId (ULID)
queue.dispatchLater(at, JobClass, payload, opts?)
queue.dispatchSync(JobClass, payload)          // run in-process, no persistence
```

`dispatchLater`'s `at` is either a `Date` (absolute) or a positive number of seconds from now. Past dates / zero clamp to "now". Negative numbers throw.

`opts.queue` and `opts.attempts` override the JobClass defaults.

## SyncQueue — in-process driver

The V1 driver for tests and single-process dev. Instantiates the Job via the container, builds a `JobContext`, calls `handle()` synchronously. No persistence, no retries — if `handle()` throws, the throw propagates.

```ts
import { Application } from '@strav/kernel'
import { SyncQueue } from '@strav/queue'

const app = new Application()
const queue = new SyncQueue({ container: app, logger: app.resolve(Logger) })

await queue.dispatch(SendWelcomeEmail, { userId: 'u-1' })   // runs immediately
```

`dispatchLater` under `SyncQueue` ignores the delay (still runs immediately) but validates the delay shape — so callers can't pass `-5` here and have it silently work, only to fail on `DatabaseQueue` later.

## DatabaseQueue — Postgres-backed driver

The production driver. `dispatch` writes a `strav_jobs` row; the Worker (next M3 slice) picks it up via `SELECT FOR UPDATE SKIP LOCKED`. Apps register `jobSchema` with their `SchemaRegistry` and migrate the table.

```ts
import { Application, EventBus } from '@strav/kernel'
import { DatabaseProvider, PostgresDatabase, SchemaRegistry } from '@strav/database'
import { DatabaseQueue, jobSchema } from '@strav/queue'

// In SchemasProvider (or wherever you register schemas):
registry.registerAll([jobSchema, /* … */])

// In QueueProvider:
new DatabaseQueue({
  db: app.resolve(PostgresDatabase),
  container: app,
  logger: app.resolve(Logger),
})
```

### Queue-until-commit

When `dispatch` is called inside `UnitOfWork.run(...)` or `TenantManager.withTenant(...)`, the INSERT routes through the ambient transaction. Atomic with the surrounding work:

```ts
await uow.run(async () => {
  await userRepo.create({ email })
  await queue.dispatch(SendWelcomeEmail, { userId: '...' })
  // If the transaction commits, both the user row AND the queue row
  // are visible. If it rolls back, neither exists.
})
```

This is the M3 spike from the spec — Postgres's transactional atomicity gives us the semantic for free. See [`docs/queue/api.md`](../../docs/queue/api.md#queue-until-commit-semantics) for the full mechanics.

### Delay mechanics

`dispatchLater` computes delays in Postgres (`now() + interval 'N seconds'`) so the Worker reads `available_at` from the same DB clock the dispatcher wrote against — no clock-skew bugs.

## Worker — the consumer side

Polls `strav_jobs`, claims via `SELECT FOR UPDATE SKIP LOCKED`, runs `handle()` with a per-attempt timeout, deletes on success, retries with backoff on failure.

```ts
import { Worker } from '@strav/queue'

const worker = new Worker({
  db: app.resolve(PostgresDatabase),
  registry: app.resolve(JobRegistry),
  container: app,
  logger: app.resolve(Logger),
  queues: ['default'],
  pollInterval: 1000,      // ms between empty polls
  timeoutSeconds: 60,      // per-attempt timeout
})

const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT',  () => controller.abort())

await worker.run(controller.signal)
```

`SKIP LOCKED` is the load-bearing primitive — multiple Worker processes can poll the same queue concurrently without picking the same row. Scale horizontally by running more processes.

Default backoff: exponential with ±25% jitter, capped at 300 seconds. Per-job override via `static backoff(attempt: number)`, per-Worker via `defaultBackoff`. Jitter prevents thundering-herd retries when many jobs fail simultaneously.

`processOne()` (single-shot) is also exposed — useful for tests + one-off CLI invocations.

## Scheduler — cron-driven dispatch

```ts
import { Scheduler, dailyAt, everyMinutes, hourly } from '@strav/queue'

const scheduler = new Scheduler({
  queue: app.resolve(Queue),
  tenants: app.resolve(TenantManager),
})

scheduler
  .schedule({ job: CleanupOldSessions, cron: hourly() })
  .schedule({ job: GenerateNightlyReports, cron: dailyAt('02:00'), oneServer: true })
  .schedule({ job: SyncStripe, cron: everyMinutes(15), oneServer: true })

const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT',  () => controller.abort())
await scheduler.run(controller.signal)
```

`oneServer: true` uses `TenantManager.withLock` to acquire a fleet-wide advisory lock + `strav_scheduler_runs.last_run_at` to track which tick boundary already dispatched. Only one server in the fleet dispatches per tick — exactly-once across however many scheduler processes you run.

Register `schedulerRunsSchema` alongside `jobSchema` in your `SchemaRegistry` so `generateMigration` picks up the table.

Cron matching is UTC-based for predictability. Helper builders cover the common cases (`everyMinute`, `everyMinutes`, `hourly`, `daily`, `dailyAt`) — reach for `cron(expression)` directly when you need weekly / monthly / arbitrary expressions.

## What's NOT here yet

Each is its own M3 slice:

- **Failed-jobs handling** — `failed_jobs` table, `queue:retry` / `queue:flush` console commands (need `@strav/cli`, lands in M4).
