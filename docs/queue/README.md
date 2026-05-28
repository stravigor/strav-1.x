# @strav/queue

Background-job primitives for Strav 1.0 — the `Job` base class, the `JobRegistry`, the `Queue` contract, and a synchronous in-process driver (`SyncQueue`). Postgres-backed `DatabaseQueue` + `Worker` (SELECT FOR UPDATE SKIP LOCKED poll loop) + `Scheduler` (cron + `onOneServer` advisory lock) land in follow-up M3 slices.

> **Status: 1.0.0-alpha — M3 in progress.** Shipping in this slice: contract layer + `SyncQueue` driver. Drivers / Worker / Scheduler / failed-jobs follow.

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

## Documentation

- [`api.md`](./api.md) — every public export with signatures + semantics.
- [`guides/jobs.md`](./guides/jobs.md) — defining a Job, payload shape, the `failed` hook, configuration, testing patterns.

## What's NOT here yet

Each is its own M3 slice on top of this contract layer:

- **`DatabaseQueue` driver** — Postgres-backed `jobs` table; `dispatch` writes a row; `dispatchLater` honors the delay column. Integrates with `UnitOfWork`'s queue-until-commit so jobs dispatched inside a transaction enqueue at COMMIT and drop on ROLLBACK (the M3 spike from the spec).
- **`Worker`** — `SELECT FOR UPDATE SKIP LOCKED` poll loop, attempt counter, exponential backoff with jitter, per-job `static backoff()` hook, graceful shutdown via `AbortSignal`.
- **`Scheduler`** — cron parser, `daily()` / `hourly()` / `everyMinutes()` builders, `SchedulerKernel.run()` minute tick, `onOneServer()` via `TenantManager.withLock` (already shipped in `@strav/database`).
- **Failed-jobs** — `failed_jobs` table + `queue:retry` / `queue:flush` console commands (need `@strav/cli`, M4).
