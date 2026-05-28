# @strav/queue — API Reference

> **Status:** V1 contract layer + two drivers shipped — `Job` + `JobContext` + `JobClass` + `PayloadOf` + `JobRegistry` + `isJobClass` + `Queue` interface + `SyncQueue` + `DatabaseQueue` + `jobSchema`. `Worker` / `Scheduler` / failed-jobs land in follow-up cuts.

## `Job<TPayload>`

```ts
abstract class Job<TPayload = unknown> {
  static readonly jobName: string                                  // subclass MUST override
  abstract handle(context: JobContext<TPayload>): Promise<void>
  failed?(context: JobFailedContext<TPayload>): Promise<void>      // optional hook

  // Optional static config (read per-attempt by the Worker):
  static maxAttempts?: number                                      // default driver-specific
  static backoff?(attempt: number): number                         // seconds; default exponential+jitter
  static timeout?: number                                          // seconds per attempt
  static queue?: string                                            // queue name; default 'default'
}
```

- `jobName` is the wire identifier. Convention: `<package>.<verb>` or `<resource>.<verb>` (e.g. `mail.welcome`, `user.cleanup`). MUST be non-empty + globally unique within the registry.
- `handle(ctx)` is called once per attempt. The Worker constructs the Job via the container (so `@inject()` deps wire up) and calls handle.
- `failed(ctx)` fires on every failed attempt (intermediate + terminal). A throw is logged but doesn't change the retry decision.
- `TPayload` must be JSON-serializable — drivers `JSON.stringify` / `JSON.parse` round-trip it.

## `JobContext<TPayload>` / `JobFailedContext<TPayload>`

```ts
interface JobContext<TPayload> {
  jobId: string          // assigned at dispatch (typically a ULID)
  attempt: number        // 1-based; 1 is the first run
  payload: TPayload      // deserialized
  signal: AbortSignal    // aborts on shutdown grace-period exhaustion or timeout
  log: Logger            // job-scoped logger (jobId + jobName + attempt prebound)
}

interface JobFailedContext<TPayload> extends JobContext<TPayload> {
  error: unknown         // the thrown value from the failed attempt
}
```

## `JobClass<TPayload>` / `PayloadOf<T>`

```ts
interface JobClass<TPayload = unknown> extends JobConfig {
  new (...args: any[]): Job<TPayload>
  readonly jobName: string
}

type PayloadOf<T> = T extends JobClass<infer P> ? P : never
```

`PayloadOf` extracts the payload type from a class — useful for typed dispatchers (`Queue.dispatch(SendWelcomeEmail, payload: PayloadOf<typeof SendWelcomeEmail>)`).

## `JobRegistry`

```ts
class JobRegistry {
  register(jobClass: JobClass): this                                          // throws ConfigError on conflict
  registerAll(jobClasses: readonly JobClass[]): this
  discover(pattern: string | string[], options?: { cwd?: string }): Promise<this>
  get(jobName: string): JobClass | undefined
  getOrFail(jobName: string): JobClass                                        // throws on miss
  has(jobName: string): boolean
  all(): readonly JobClass[]
  clear(): void                                                                // test helper
}

function isJobClass(value: unknown): value is JobClass
```

- `register`: throws when `jobName` is empty, or when a DIFFERENT class already owns it. Re-registering the same class is a silent no-op.
- `discover`: `Bun.Glob`-based; `cwd` defaults to `process.cwd()`. Re-exports of the same class through a barrel dedupe by identity. Files exporting no Job classes are silently skipped.
- `isJobClass`: conservative — requires `value.prototype instanceof Job` AND a non-empty `jobName`. Exported so apps can build their own discovery loops.

## `Queue` (interface)

```ts
interface Queue {
  dispatch<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    opts?: DispatchOptions,
  ): Promise<string>                                  // returns jobId (ULID)

  dispatchLater<TJob extends JobClass>(
    at: Date | number,                                // Date OR seconds-from-now
    jobClass: TJob,
    payload: PayloadOf<TJob>,
    opts?: DispatchLaterOptions,
  ): Promise<string>

  dispatchSync<TJob extends JobClass>(
    jobClass: TJob,
    payload: PayloadOf<TJob>,
  ): Promise<void>                                    // in-process, no persistence
}

interface DispatchOptions {
  queue?: string         // overrides JobClass's static queue (default 'default')
  attempts?: number      // overrides JobClass's static maxAttempts
}
interface DispatchLaterOptions extends DispatchOptions {}
```

- `dispatch` enqueues for a Worker to pick up.
- `dispatchLater`: `Date` (absolute) or `number` (seconds-from-now). Past dates / zero clamp to "now". Negative seconds throw.
- `dispatchSync`: instantiates + runs handle in the caller's process. No queue row, no retries.

## `SyncQueue`

V1's in-process Queue driver. Useful for tests and single-process dev. Same surface as the future `DatabaseQueue`, but everything runs synchronously and nothing persists.

```ts
class SyncQueue implements Queue {
  constructor(opts: SyncQueueOptions)
  // (Queue interface methods)
}

interface SyncQueueOptions {
  container: Container       // used to construct Jobs (resolves @inject() deps)
  logger?: Logger            // attached to every JobContext.log; default: no-op
}
```

Semantics specific to this driver:

- `dispatch`: runs `handle()` synchronously. If `handle()` throws, the throw propagates to the dispatcher (no retries).
- `dispatchLater`: ignores the delay (still runs immediately). Validates the delay shape — negative numeric delays throw to maintain parity with the `DatabaseQueue` contract.
- `dispatchSync`: identical to `dispatch`, returns `void` instead of the job id.
- The `JobContext.signal` is a never-aborted signal (SyncQueue completes in one tick, abort isn't a thing).

Default logger is a no-op so `bun test` is silent without wiring `LoggerProvider`.

## `DatabaseQueue`

The production driver. Persists each `dispatch` / `dispatchLater` as a `strav_jobs` row; Workers (next M3 slice) pick rows up via `SELECT FOR UPDATE SKIP LOCKED` and run `handle()`.

```ts
class DatabaseQueue implements Queue {
  constructor(opts: DatabaseQueueOptions)
}

interface DatabaseQueueOptions {
  db: Database                  // primary Postgres pool
  container: Container          // used by dispatchSync to construct jobs
  logger?: Logger               // attached to dispatchSync JobContext.log
  defaultAttempts?: number      // fallback when neither JobClass nor opts set it; default 3
  defaultQueue?: string         // fallback queue name; default 'default'
}
```

### Queue-until-commit semantics

When `dispatch` / `dispatchLater` is called inside `UnitOfWork.run(...)` or `TenantManager.withTenant(...)`, the driver reads the ambient transactional context (via `currentTransactionalContext()` from `@strav/database`) and routes the INSERT through `ctx.tx` instead of `this.db`. The new row commits + rolls back atomically with the surrounding transaction:

- **COMMIT** → row is visible to Workers; job runs.
- **ROLLBACK** → row never existed; job is dropped.

This is the M3 spike from the spec ("flush queue on commit; drop on rollback"). Postgres's transactional atomicity gives us the semantic for free — no deferred-callback machinery, no second event queue.

Outside a transactional scope, `dispatch` writes against `db` directly (auto-commit).

### `dispatchSync` semantics

Identical to `SyncQueue.dispatchSync`: instantiates the Job via the container, builds a `JobContext`, runs `handle()` synchronously. No queue row, no retries. Useful for callers that want to bypass persistence even when `DatabaseQueue` is the wired driver (e.g., a test that wants to assert handler behavior without depending on a Worker).

### `dispatchLater` mechanics

Delays are computed in Postgres: the SQL emits `now() + interval 'N seconds'` rather than a wall-clock timestamp from the dispatcher. The Worker reads `available_at` from the same DB clock, so dispatcher-vs-worker clock skew can't cause a job to run early or late.

- `dispatchLater(n: number, ...)` — `n` seconds from `now()`. Negative throws; `0` is the same as `dispatch`.
- `dispatchLater(at: Date, ...)` — computes `(at - Date.now())` seconds; past Dates clamp to immediate (no `interval` fragment, just `now()`).

## `jobSchema`

```ts
export const jobSchema: Schema
```

The `strav_jobs` table definition (`defineSchema('strav_jobs', Archetype.Entity, ...)`). Apps register it with their `SchemaRegistry` and `generateMigration` picks it up:

```ts
registry.registerAll([userSchema, jobSchema, /* … */])
await generateMigration({ registry, db })
```

Columns (in declaration order): `id` (ULID PK), `queue` (varchar(64), default `'default'`), `job_name` (varchar(128)), `payload` (jsonb), `attempts` (integer, default 0), `max_attempts` (integer, default 3), `available_at` (timestamptz), `reserved_at` (timestamptz, nullable), `created_at` / `updated_at` (timestamptz, via `t.timestamps()`).

Not `tenanted: true` — the queue is system-level. Apps that want per-tenant queues can clone the schema with a `tenant_id` FK + RLS (follow-up).
