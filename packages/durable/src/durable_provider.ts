/**
 * `DurableProvider` — wires the durable runtime into the container.
 *
 * `register()`:
 *   - Binds `WorkflowRegistry` as a singleton — apps wire workflows
 *     into it from their own provider's `boot()`.
 *   - Binds `DurableRunner` as a singleton; resolves the Postgres
 *     pool, the `Queue` driver (passed via constructor options), the
 *     registry, and (optionally) the `Logger`.
 *
 * `boot()`:
 *   - Registers both schemas on the app's `SchemaRegistry` so they
 *     show up in `db:migrate:generate` output.
 *   - Eagerly resolves the runner so a misconfigured app fails at
 *     boot, not on the first start() call.
 *
 * The provider does NOT auto-discover workflows — apps register them
 * explicitly. The `discover` slice lands when an app needs it.
 *
 * `@strav/queue` doesn't ship a `QueueProvider` — apps bind their
 * queue driver (typically `DatabaseQueue` in production, `SyncQueue`
 * in tests) in their own provider's `register()`. DurableProvider's
 * constructor takes the queue class so the runtime knows which
 * binding to resolve.
 */

import { type Application, LogManager, ServiceProvider } from '@strav/kernel'
import { PostgresDatabase, SchemaRegistry } from '@strav/database'
import type { JobClass, Queue } from '@strav/queue'
import { DurableAdvanceJob } from './durable_advance_job.ts'
import { DurableCompensateJob } from './durable_compensate_job.ts'
import { workflowJournalSchema } from './journal_schema.ts'
import { workflowRunsSchema } from './runs_schema.ts'
import { DurableRunner } from './durable_runner.ts'
import { WorkflowRegistry } from './workflow_registry.ts'

export interface DurableProviderOptions {
  /**
   * Concrete `Queue` driver class. Apps bind one (typically
   * `DatabaseQueue` for production, `SyncQueue` for tests) in their
   * own provider, then pass the class here so `DurableRunner` can
   * resolve it from the container.
   */
  // biome-ignore lint/suspicious/noExplicitAny: container constructor accepts any[]
  queue: new (...args: any[]) => Queue
  /**
   * Optional Job class overrides. Defaults to the shipped
   * `DurableAdvanceJob` / `DurableCompensateJob`. Apps that subclass
   * the Jobs (custom logging, custom dead-letter routing) pass their
   * subclass here.
   */
  advanceJob?: JobClass
  compensateJob?: JobClass
}

export class DurableProvider extends ServiceProvider {
  override readonly name = 'durable'
  override readonly dependencies = ['database']

  constructor(private readonly options: DurableProviderOptions) {
    super()
  }

  override register(app: Application): void {
    app.singleton(WorkflowRegistry, () => new WorkflowRegistry())
    app.singleton(DurableRunner, (c) => {
      const runnerOptions: ConstructorParameters<typeof DurableRunner>[0] = {
        db: c.resolve(PostgresDatabase),
        queue: c.resolve(this.options.queue),
        registry: c.resolve(WorkflowRegistry),
        advanceJob: this.options.advanceJob ?? DurableAdvanceJob,
        compensateJob: this.options.compensateJob ?? DurableCompensateJob,
      }
      if (c.has(LogManager)) {
        runnerOptions.logger = c.resolve(LogManager).channel('durable')
      }
      if (c.has(SchemaRegistry)) runnerOptions.schemas = c.resolve(SchemaRegistry)
      return new DurableRunner(runnerOptions)
    })
  }

  override boot(app: Application): void {
    if (app.has(SchemaRegistry)) {
      const registry = app.resolve(SchemaRegistry)
      if (!registry.has(workflowRunsSchema.name)) registry.register(workflowRunsSchema)
      if (!registry.has(workflowJournalSchema.name)) registry.register(workflowJournalSchema)
    }
    // Eager-resolve so misconfiguration fails at boot.
    app.resolve(DurableRunner)
  }
}
