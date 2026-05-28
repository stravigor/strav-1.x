# Console commands

`@strav/queue` ships seven console commands behind `QueueConsoleProvider`. Add it to `bootstrap/providers.ts` and the CLI picks them up automatically.

```ts
import { QueueConsoleProvider } from '@strav/queue'

export const providers = [
  // …other providers…
  new QueueConsoleProvider(),
]
```

`QueueConsoleProvider` doesn't bind `Worker` / `Scheduler` itself — their construction is app-specific (queue names, registered jobs, schedule entries). Apps wire those in their own provider:

```ts
app.singleton(Worker, (c) =>
  new Worker({
    db: c.resolve(PostgresDatabase),
    registry: c.resolve(JobRegistry),
    container: c.container,
    logger: c.resolve(Logger),
    queues: ['default', 'mail'],
  }),
)

app.singleton(Scheduler, (c) => {
  const scheduler = new Scheduler({
    queue: c.resolve(DatabaseQueue),
    tenants: c.resolve(TenantManager),
    logger: c.resolve(Logger),
  })
  scheduler.schedule({ job: WeeklyReport, cron: weekly(), oneServer: true })
  return scheduler
})
```

## Workers

### `bun strav queue:work [--queue=default] [--max=N]`

Runs a queue worker until the process is interrupted. SIGINT / SIGTERM aborts the loop cleanly (in-flight jobs finish, the SKIP LOCKED row is released).

- `--queue=name` — informational; the actual queue list is the `queues` array the Worker was constructed with.
- `--max=N` — exit after N completed jobs. Hosted runtimes (Render workers, supervised tasks) often prefer "exit so the supervisor restarts" over an unbounded loop.

Omitting `--max` calls `worker.run(signal)`; setting `--max=N` loops on `processOne()` so the count is honored even when the queue empties out (sleeps 1s between empty polls).

### `bun strav queue:retry <id>` / `--all`

Re-enqueues failed job(s) from `strav_failed_jobs` back into `strav_jobs`. One transaction per command invocation — a crash mid-move can't lose rows or double-enqueue. Attempts are reset to 0; `available_at` is `now()`.

```bash
bun strav queue:retry 01HK…       # one job
bun strav queue:retry --all        # everything in the dead-letter table
```

### `bun strav queue:flush [--queue=name] [--force]`

`DELETE FROM strav_jobs` (optionally filtered by queue). Confirms before running unless `--force`. Doesn't touch `strav_failed_jobs` — that's separate, managed via `queue:retry` or app-level cleanup.

### `bun strav queue:failed`

Reads `strav_failed_jobs` and prints a table — id, queue, job, attempts, failed-at, first line of the exception. Read-only.

## Scheduler

### `bun strav scheduler:work`

Long-running tick loop. SIGINT aborts; the Scheduler's own semantics return within one tick.

### `bun strav scheduler:list`

Table of every registered entry — name, cron expression, job name, oneServer flag. Pure introspection.

### `bun strav scheduler:run <name>`

Force-dispatch one named entry on demand, bypassing the cron expression. Honors `oneServer: true` — the advisory lock + run-tracking row still apply, so concurrent invocations from different machines can't double-dispatch.

```bash
bun strav scheduler:run scheduler.fixture
```

Returns exit code 2 with a clear stderr message when the name doesn't match a registered entry.

## Process model

The split between `queue:work` and `scheduler:work` matches the [process tier model](../../application-lifecycle.md#process-model-three-tiers): a queue worker drains jobs; a scheduler dispatches them on cron boundaries. For small deployments, `bun strav all` (slice 5) will run HTTP + worker + scheduler in one Bun process. For production, each runs as its own service.
