# @strav/queue

Background-job primitives for Strav 1.0 — the `Job` base class, the `JobRegistry`, the `Queue` contract, and a synchronous in-process driver. Postgres-backed `DatabaseQueue` + `Worker` + `Scheduler` land in follow-up M3 slices.

> **Status: 1.0.0-alpha — M3 in progress (contract layer + `SyncQueue` + `DatabaseQueue` with queue-until-commit shipped; Worker / Scheduler to follow).**

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

## What's NOT here yet

Each is its own M3 slice:

- **`Worker`** — `SELECT FOR UPDATE SKIP LOCKED` poll loop, attempt counter, exponential backoff with jitter, per-job `static backoff()` hook, graceful shutdown via `AbortSignal`.
- **`Scheduler`** — cron parser, `daily()` / `hourly()` / `everyMinutes()` builders, `SchedulerKernel.run()` minute tick, `onOneServer()` advisory lock (built on `TenantManager.withLock` from `@strav/database`).
- **Failed-jobs handling** — `failed_jobs` table, `queue:retry` / `queue:flush` console commands (need `@strav/cli`, lands in M4).
