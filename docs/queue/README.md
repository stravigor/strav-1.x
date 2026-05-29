# @strav/queue

Background-job primitives for Strav 1.0 — the `Job` base class + `JobRegistry` + `Queue` contract + two drivers (`SyncQueue` in-process + `DatabaseQueue` Postgres-backed with queue-until-commit semantics) + `Worker` (SELECT FOR UPDATE SKIP LOCKED poll loop, backoff, abort-aware shutdown) + `Scheduler` (cron + `onOneServer` advisory lock).

> **Status: 1.0.0-alpha.10 — queue package functionally complete.** Shipping: contract layer + `SyncQueue` + `DatabaseQueue` (queue-until-commit) + `jobSchema` + `Worker` (SKIP LOCKED + backoff + atomic-move-to-failed) + `Scheduler` (cron + `onOneServer`) + `schedulerRunsSchema` + `failedJobsSchema`. Console commands now ship via `@strav/cli`'s `QueueConsoleProvider`.

## Install

```bash
bun add @strav/queue
```

Peer dep: `@strav/kernel`.

## What's here (contract layer)

| Symbol | Purpose |
|---|---|
| `Job<TPayload>` | Abstract base class. Subclasses set `static jobName` + implement `handle(ctx)`. Optional static config: `maxAttempts` / `backoff(attempt)` / `timeout` / `queue`. Optional `failed(ctx)` hook for routing to dead-letter / Slack |
| `JobContext<TPayload>` | Per-invocation context: `jobId`, `attempt`, `payload`, `signal` (abort), `log` (Logger) |
| `JobFailedContext<TPayload>` | `JobContext` + `error` — passed to the `failed` hook |
| `JobClass<TPayload>` | Constructor reference type. Combines the new-able shape with the static `jobName` + config fields |
| `PayloadOf<T>` | Helper type — extract payload type from a `JobClass` |
| `JobRegistry` | Runtime catalog. `register` / `registerAll` for explicit wiring; `await discover(pattern, { cwd? })` for `Bun.Glob` auto-discovery (parallel to `SchemaRegistry.discover`) |
| `isJobClass(value)` | Type-guard used by `discover()`. Conservative: requires `prototype instanceof Job` AND a non-empty `jobName` |
| `Queue` (interface) | The runtime contract — `dispatch` / `dispatchLater` / `dispatchSync` |
| `DispatchOptions` | Optional per-dispatch overrides (`queue`, `attempts`) |
| `DispatchLaterOptions` | Same shape as `DispatchOptions` — slot reserved for future fields (`priority`, `deduplicationKey`) |
| `SyncQueue` | Concrete in-process Queue driver. Instantiates via container + runs `handle()` synchronously. No persistence, no retries. Tests + single-process dev |
| `SyncQueueOptions` | `{ container: Container, logger?: Logger }` |
| `DatabaseQueue` | Postgres-backed Queue driver. `dispatch` writes a `strav_jobs` row; inside `UnitOfWork.run` / `TenantManager.withTenant` the INSERT routes through the ambient tx (queue-until-commit). `dispatchSync` bypasses persistence |
| `DatabaseQueueOptions` | `{ db: Database, container: Container, logger?: Logger, defaultAttempts?: number, defaultQueue?: string }` |
| `jobSchema` | The `strav_jobs` `Schema` apps register + migrate. ULID PK + queue / job_name / payload / attempts / max_attempts / available_at / reserved_at / timestamps |
| `Worker` | Consumer side. `processOne()` claims via SELECT FOR UPDATE SKIP LOCKED + runs handle + deletes/retries. `run(signal)` is the poll loop with graceful shutdown |
| `WorkerOptions` | `{ db, registry, container, logger?, queues?, pollInterval?, timeoutSeconds?, defaultAttempts?, defaultBackoff? }` |
| `JobResult` | `processOne()` return — `{ status: 'completed' \| 'retried' \| 'failed', ... }` |
| `CronExpression` | 5-field cron parser + `matches(date)`. UTC-based |
| `cron` / `everyMinute` / `everyMinutes` / `hourly` / `daily` / `dailyAt` | `CronExpression` factory helpers |
| `Scheduler` | Recurring dispatch on a cron cadence. `.schedule({ job, cron, oneServer? })` registers; `.tick()` processes one boundary; `.run(signal)` is the minute-loop. `oneServer` uses `TenantManager.withLock` + `strav_scheduler_runs` for exactly-once-per-tick |
| `SchedulerOptions` / `ScheduleOptions` | Constructor + registration option shapes |
| `schedulerRunsSchema` | The `strav_scheduler_runs` `Schema` — ULID PK + `name` UNIQUE + `last_run_at` for `oneServer` run-tracking |
| `failedJobsSchema` | The `strav_failed_jobs` dead-letter `Schema` — terminal failures land here atomically (INSERT + DELETE in one tx). Carries the original queue / job_name / payload + the captured exception + attempts + failed_at |

## Documentation

- [`api.md`](./api.md) — every public export with signatures + semantics.
- [`guides/jobs.md`](./guides/jobs.md) — defining a Job, payload shape, the `failed` hook, configuration, testing patterns.

## What's NOT here yet

- **`queue:retry` / `queue:flush` console commands** — operate on the `strav_failed_jobs` table for bulk re-enqueue / drop. Waits on `@strav/cli` in M4. Until then, apps that need to retry SELECT the failed row, INSERT into `strav_jobs` with the same payload, DELETE from `strav_failed_jobs` by hand.
