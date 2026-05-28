# Jobs

A Job is a unit of background work — a class that captures "the thing to do" with its dependencies resolved by the container and its payload serialized through the queue.

## Defining a Job

Subclass `Job<TPayload>`, declare a stable `static jobName`, implement `handle(ctx)`.

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
    ctx.log.info('welcome email sent', { userId: ctx.payload.userId })
  }
}
```

### Conventions

- **`jobName`**: stable wire identifier (`<package>.<verb>` or `<resource>.<verb>`). Changing it strands in-flight queue rows that reference the old name — treat it like a database column name.
- **Payload**: JSON-serializable. Pass primitive ids (`userId: string`) rather than full Model instances; rehydrate via Repository inside `handle()`. Keeps the queue row compact AND avoids the "stale snapshot" problem (the user's state at dispatch time vs at process time).
- **One job per file**: file name = primary export, `snake_cased.ts`, in `app/Jobs/`. Auto-discovery via `JobRegistry.discover('app/Jobs/**/*.ts')` picks them up.

## Payload + context shape

```ts
interface JobContext<TPayload> {
  jobId: string          // assigned at dispatch (ULID)
  attempt: number        // 1-based; 1 is the first try
  payload: TPayload      // deserialized
  signal: AbortSignal    // shutdown grace / timeout
  log: Logger            // prebound with jobId + jobName + attempt
}
```

Inside `handle`:

- Use `ctx.payload` for the input data.
- Use `ctx.log.info(...)` for structured logging — the kernel routes it through the configured channel.
- Use `ctx.signal` to bail out of long-running work cleanly:

```ts
async handle(ctx: JobContext<{ batchId: string }>): Promise<void> {
  for (const row of await this.batch.rows(ctx.payload.batchId)) {
    if (ctx.signal.aborted) return    // graceful shutdown or timeout
    await this.process(row)
  }
}
```

## Configuration overrides

Static fields on the subclass — every one optional, every one read per-attempt by the Worker:

```ts
class SendWelcomeEmail extends Job<...> {
  static override readonly jobName = 'mail.welcome'
  static override readonly maxAttempts = 5
  static override readonly timeout = 30        // seconds per attempt
  static override readonly queue = 'mail'      // named queue
  static override backoff(attempt: number): number {
    return Math.min(60, 2 ** attempt)          // 2, 4, 8, 16, 32, 60, 60, …
  }
}
```

Per-dispatch overrides via `DispatchOptions` win over the static defaults:

```ts
await queue.dispatch(SendWelcomeEmail, { userId: 'u-1' }, { queue: 'priority', attempts: 1 })
```

## The `failed` hook

Fires when an attempt throws — both on intermediate failures (with retries still available) AND on the final terminal failure. The Worker passes a `JobFailedContext` (regular context + the error):

```ts
async failed(ctx: JobFailedContext<{ userId: string }>): Promise<void> {
  await slack.post(
    `Welcome email failed for ${ctx.payload.userId}: ${(ctx.error as Error).message}`,
  )
}
```

A throw from `failed()` is logged but doesn't change the retry decision — `failed()` is a notification hook, not a control point.

## Registering jobs

```ts
// Explicit
new JobRegistry().registerAll([SendWelcomeEmail, ProcessInvoiceBatch, /* … */])

// Auto-discovery (Bun.Glob — same shape as SchemaRegistry.discover)
await registry.discover('app/Jobs/**/*.ts')
```

`register` throws `ConfigError` when:
- `jobName` is empty (subclass forgot to override).
- A DIFFERENT class already owns the same `jobName`.

Re-registering the SAME class is silently idempotent (handles barrel re-imports under `discover`).

## Dispatching from controllers / services

```ts
// In a controller / service:
constructor(private readonly queue: Queue) {}

async store(ctx: HttpContext): Promise<Response> {
  const user = await this.users.create({ ... })
  await this.queue.dispatch(SendWelcomeEmail, { userId: user.id })
  return ctx.response.created(user)
}
```

For delayed dispatch:

```ts
// 5 minutes from now
await this.queue.dispatchLater(5 * 60, SendReminder, { userId })

// Specific time
await this.queue.dispatchLater(new Date('2026-06-01T09:00:00Z'), CleanupOldSessions, {})
```

## Testing

`SyncQueue` is the V1 driver for tests. It instantiates the Job via the container (so `@inject()` deps wire up the same way the production Worker would) and runs `handle()` synchronously:

```ts
import { Application } from '@strav/kernel'
import { SyncQueue } from '@strav/queue'

const app = new Application()
app.singleton(UserRepository, () => fakeUserRepo)
app.singleton(MailManager, () => fakeMail)

const queue = new SyncQueue({ container: app })
await queue.dispatch(SendWelcomeEmail, { userId: 'u-1' })

expect(fakeMail.sent).toHaveLength(1)
expect(fakeMail.sent[0]?.subject).toBe('Welcome')
```

Throws from `handle()` propagate — no retries under `SyncQueue`. Treat each `await queue.dispatch(...)` as a synchronous unit of work.

For Job-class unit testing without going through a queue, just `new MyJob(...)` directly and call `handle(ctx)` with a fixture context:

```ts
const job = new SendWelcomeEmail(fakeUserRepo, fakeMail)
await job.handle({
  jobId: '01HZ…',
  attempt: 1,
  payload: { userId: 'u-1' },
  signal: new AbortController().signal,
  log: noopLogger,
})
```

## What's deferred

- **`DatabaseQueue` driver** — production driver; Postgres-backed `jobs` table; integrates with `UnitOfWork` queue-until-commit.
- **`Worker`** — poll loop, retry orchestration, exponential backoff with jitter, graceful shutdown.
- **`Scheduler`** — cron parser + `onOneServer` via `TenantManager.withLock`.
- **Failed-jobs** — `failed_jobs` table + `queue:retry` / `queue:flush` commands (need `@strav/cli`, lands in M4).
