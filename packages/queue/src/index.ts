// Public API of @strav/queue.
//
// V1 ships:
//   - Job + JobContext + JobClass + PayloadOf — the unit of work + types.
//   - JobRegistry + Bun.Glob auto-discovery + isJobClass type-guard.
//   - Queue interface with dispatch / dispatchLater / dispatchSync.
//   - SyncQueue — in-process synchronous driver for tests + single-process dev.
//   - DatabaseQueue — Postgres-backed driver with queue-until-commit semantics
//     via @strav/database's transactional ALS.
//   - jobSchema — the `_strav_jobs` Schema apps register + migrate.
//
// Still deferred (each is its own M3 slice):
//   - Worker (SELECT FOR UPDATE SKIP LOCKED poll loop, attempt counter,
//     exponential backoff with jitter, graceful shutdown via AbortSignal)
//   - Scheduler (cron parser + onOneServer advisory lock via
//     TenantManager.withLock)
//   - failed_jobs table + queue:retry / failed:* console commands

export { DatabaseQueue, type DatabaseQueueOptions } from './database_queue.ts'
export {
  Job,
  type JobClass,
  type JobConfig,
  type JobContext,
  type JobFailedContext,
  type PayloadOf,
} from './job.ts'
export { isJobClass, JobRegistry } from './job_registry.ts'
export { jobSchema } from './job_schema.ts'
export type { DispatchLaterOptions, DispatchOptions, Queue } from './queue.ts'
export { SyncQueue, type SyncQueueOptions } from './sync_queue.ts'
