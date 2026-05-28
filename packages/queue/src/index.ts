// Public API of @strav/queue.
//
// V1 ships the contract layer + a synchronous in-process driver:
//   - Job + JobContext + JobClass + PayloadOf — the unit of work + types.
//   - JobRegistry + isSchema-style type-guard + Bun.Glob auto-discovery.
//   - Queue interface with dispatch / dispatchLater / dispatchSync.
//   - SyncQueue — instantiates jobs via the container, runs handle()
//     synchronously. Useful for tests + single-process dev.
//
// Still deferred (each is its own M3 slice):
//   - DatabaseQueue driver (Postgres-backed; UnitOfWork queue-until-commit)
//   - Worker (SELECT FOR UPDATE SKIP LOCKED poll loop, attempt counter,
//     exponential backoff with jitter)
//   - Scheduler (cron parser + onOneServer advisory lock via
//     TenantManager.withLock)
//   - failed_jobs table + queue:retry / failed:* console commands

export {
  Job,
  type JobClass,
  type JobConfig,
  type JobContext,
  type JobFailedContext,
  type PayloadOf,
} from './job.ts'
export { isJobClass, JobRegistry } from './job_registry.ts'
export type { DispatchLaterOptions, DispatchOptions, Queue } from './queue.ts'
export { SyncQueue, type SyncQueueOptions } from './sync_queue.ts'
