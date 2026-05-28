/**
 * `Repository<TModel>` — the injectable data-access object for one Model.
 *
 * One repository per Model. Holds CRUD + the `query()` builder +
 * resource-specific finders (apps add them in subclasses). Receives the
 * `PostgresDatabase` via constructor injection — `@inject()` on the
 * subclass picks it up through `reflect-metadata`.
 *
 * The `db` parameter is typed as `PostgresDatabase` (concrete class) rather
 * than the `Database` interface because the container's `@inject()` flow
 * needs a runtime class reference. Apps that swap the driver bind their
 * subclass under `PostgresDatabase` — same shape as `@strav/auth`'s
 * `ExceptionHandler` pattern.
 *
 * Subclasses declare:
 *   - `static schema = userSchema`
 *   - `static model = User`
 *
 * Every public method takes an optional `{ tx? }` scope as its final arg.
 * Resolution order for the executor:
 *   1. Explicit `opts.tx` wins.
 *   2. Otherwise, an ambient `UnitOfWork.run` scope (via AsyncLocalStorage)
 *      provides the tx — no plumbing needed at the call site.
 *   3. Falls back to `this.db` (auto-commit per query).
 *
 * Deferred in this slice (each is its own follow-up):
 *   - Soft-delete integration (`.withTrashed()`, `delete()` writing
 *     `deleted_at` instead of dropping the row)
 *   - Relationships + eager loading (`.with('relation')`)
 *   - Pagination helpers (`.paginate` / `.cursorPaginate`)
 */

import { type EventBus, NotFoundError } from '@strav/kernel'
import type { Database, DatabaseExecutor, PostgresDatabase } from '../database.ts'
import type { Schema } from '../schema/types.ts'
import { transactionalStorage } from '../unit_of_work/context.ts'
import { hydrateRow, type ModelClass } from './model.ts'
import { QueryBuilder } from './query_builder.ts'
import {
  emitDeleteById,
  emitFindById,
  emitFindMany,
  emitInsert,
  emitUpdateById,
} from './sql_emitter.ts'

/** Optional transaction scope for any Repository call. */
export interface RepositoryScope {
  /**
   * Run the call against this executor instead of the default. Pass the
   * `tx` argument you got from `UnitOfWork.run(fn)` (or from one of the
   * `withTenant` / `withoutTenant` callbacks). Inside a UoW scope this
   * is also picked up automatically via AsyncLocalStorage — explicit
   * `tx` here just overrides.
   */
  tx?: DatabaseExecutor
}

/**
 * Repository lifecycle event payloads. The discriminant is the event name
 * itself (`<resource>.creating` / `.created` / etc.); the payload carries
 * the resource name + the model / changes.
 *
 * `.<verb>ing` events are cancelable — a throwing listener aborts the
 * SQL. `.<verb>ed` events fire AFTER the SQL succeeds; listener throws
 * are logged but don't roll back (and won't, until the queue-until-
 * commit slice ships alongside Repository tx-routing).
 */
export interface RepositoryCreatingEvent<TModel> {
  resource: string
  attrs: Partial<TModel>
}
export interface RepositoryCreatedEvent<TModel> {
  resource: string
  model: TModel
}
export interface RepositoryUpdatingEvent<TModel> {
  resource: string
  model: TModel
  changes: Partial<TModel>
}
export interface RepositoryUpdatedEvent<TModel> {
  resource: string
  model: TModel
  changes: Partial<TModel>
}
export interface RepositoryDeletingEvent<TModel> {
  resource: string
  model: TModel
}
export interface RepositoryDeletedEvent<TModel> {
  resource: string
  model: TModel
}

export abstract class Repository<TModel extends object> {
  /** The schema this Repository operates on. Subclasses MUST set this. */
  static readonly schema: Schema
  /** The Model class to hydrate rows onto. Subclasses MUST set this. */
  static readonly model: ModelClass

  protected readonly schema: Schema
  protected readonly modelCtor: ModelClass<TModel & { constructor: ModelClass<TModel> }>

  /**
   * `events` is optional so subclasses that don't need lifecycle hooks can
   * stay as-is (and so apps under test can construct a Repository without
   * wiring a bus). When the param IS bound (which the @inject() flow does
   * automatically in real apps), `create` / `update` / `delete` fire the
   * canonical `<resource>.<verb>ing` / `.<verb>ed` events.
   */
  constructor(
    protected readonly db: PostgresDatabase,
    protected readonly events?: EventBus,
  ) {
    const Ctor = this.constructor as unknown as {
      schema?: Schema
      model?: ModelClass<TModel & { constructor: ModelClass<TModel> }>
    }
    if (!Ctor.schema) {
      throw new Error(
        `Repository: ${this.constructor.name} must declare \`static schema = …\` to know which table to operate on.`,
      )
    }
    if (!Ctor.model) {
      throw new Error(
        `Repository: ${this.constructor.name} must declare \`static model = …\` to know which Model class to hydrate.`,
      )
    }
    this.schema = Ctor.schema
    this.modelCtor = Ctor.model
  }

  // ─── Finders ───────────────────────────────────────────────────────────────

  async find(id: string | number, opts?: RepositoryScope): Promise<TModel | null> {
    const { sql, params } = emitFindById(this.schema, id)
    const row = await this.executor(opts).queryOne<Record<string, unknown>>(sql, params)
    return row ? this.hydrate(row) : null
  }

  async findOrFail(id: string | number, opts?: RepositoryScope): Promise<TModel> {
    const found = await this.find(id, opts)
    if (!found) {
      throw new NotFoundError(`${this.schema.name} "${id}" not found.`, {
        code: `${this.schema.name}.not-found`,
        context: { id },
      })
    }
    return found
  }

  async findMany(ids: readonly (string | number)[], opts?: RepositoryScope): Promise<TModel[]> {
    if (ids.length === 0) return []
    const { sql, params } = emitFindMany(this.schema, ids)
    const rows = await this.executor(opts).query<Record<string, unknown>>(sql, params)
    return rows.map((r) => this.hydrate(r))
  }

  async first(opts?: RepositoryScope): Promise<TModel | null> {
    return this.query(opts).first()
  }

  async all(opts?: RepositoryScope): Promise<TModel[]> {
    return this.query(opts).get()
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  async create(attrs: Partial<TModel>, opts?: RepositoryScope): Promise<TModel> {
    await this.emit<RepositoryCreatingEvent<TModel>>('creating', {
      resource: this.schema.name,
      attrs,
    })
    const { sql, params } = emitInsert(this.schema, attrs as Record<string, unknown>)
    const row = await this.executor(opts).queryOne<Record<string, unknown>>(sql, params)
    if (!row) {
      throw new Error(
        `Repository.create("${this.schema.name}"): RETURNING * did not produce a row.`,
      )
    }
    const model = this.hydrate(row)
    await this.emit<RepositoryCreatedEvent<TModel>>('created', {
      resource: this.schema.name,
      model,
    })
    return model
  }

  async update(model: TModel, changes: Partial<TModel>, opts?: RepositoryScope): Promise<TModel> {
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.update("${this.schema.name}"): the model has no \`id\` to update by.`,
      )
    }
    await this.emit<RepositoryUpdatingEvent<TModel>>('updating', {
      resource: this.schema.name,
      model,
      changes,
    })
    const { sql, params } = emitUpdateById(this.schema, id, changes as Record<string, unknown>)
    const row = await this.executor(opts).queryOne<Record<string, unknown>>(sql, params)
    if (!row) {
      throw new NotFoundError(`${this.schema.name} "${String(id)}" no longer exists.`, {
        code: `${this.schema.name}.not-found`,
        context: { id },
      })
    }
    const next = this.hydrate(row)
    await this.emit<RepositoryUpdatedEvent<TModel>>('updated', {
      resource: this.schema.name,
      model: next,
      changes,
    })
    return next
  }

  async delete(model: TModel, opts?: RepositoryScope): Promise<void> {
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.delete("${this.schema.name}"): the model has no \`id\` to delete by.`,
      )
    }
    await this.emit<RepositoryDeletingEvent<TModel>>('deleting', {
      resource: this.schema.name,
      model,
    })
    const { sql, params } = emitDeleteById(this.schema, id)
    await this.executor(opts).execute(sql, params)
    await this.emit<RepositoryDeletedEvent<TModel>>('deleted', {
      resource: this.schema.name,
      model,
    })
  }

  // ─── Lifecycle helper ──────────────────────────────────────────────────────

  /**
   * Emit `<resource>.<verb>` on the bus when one was wired.
   *
   * Cancelable (`<verb>ing`) events ALWAYS fire immediately so a throwing
   * listener can abort the SQL — queueing would defeat the abort semantic.
   *
   * Post-events (`<verb>ed`) queue onto the ambient `UnitOfWork.run`
   * transactional context when one exists, and flush after the user's
   * callback returns (before the implicit COMMIT). On rollback, the queue
   * drops and no side effect fires for a transaction that didn't commit.
   *
   * Outside a UoW scope, post-events also fire immediately — same shape
   * as the lifecycle slice that shipped before tx-routing.
   */
  private async emit<P>(verb: string, payload: P): Promise<void> {
    if (!this.events) return
    const name = `${this.schema.name}.${verb}`
    const isPostEvent = !verb.endsWith('ing')
    if (isPostEvent) {
      const ctx = transactionalStorage.getStore()
      if (ctx) {
        ctx.queue.push({ name, payload })
        return
      }
    }
    await this.events.emit(name, payload)
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /** Fluent query builder scoped to this repository's schema. */
  query(opts?: RepositoryScope): QueryBuilder<TModel> {
    return new QueryBuilder<TModel>(this.schema, this.executor(opts), this.modelCtor)
  }

  // ─── Aggregates ────────────────────────────────────────────────────────────

  async exists(where: Partial<TModel>, opts?: RepositoryScope): Promise<boolean> {
    return this.query(opts)
      .where(where as Record<string, unknown>)
      .exists()
  }

  async count(where?: Partial<TModel>, opts?: RepositoryScope): Promise<number> {
    const builder = this.query(opts)
    const q = where ? builder.where(where as Record<string, unknown>) : builder
    return q.count()
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Resolve the DatabaseExecutor for this call.
   *   1. Explicit `opts.tx` wins.
   *   2. Ambient `UnitOfWork.run` scope (AsyncLocalStorage) supplies tx.
   *   3. Falls back to `this.db` (auto-commit per query).
   */
  protected executor(opts?: RepositoryScope): DatabaseExecutor {
    if (opts?.tx) return opts.tx
    const ambient = transactionalStorage.getStore()
    if (ambient) return ambient.tx
    return this.db as unknown as Database
  }

  protected hydrate(row: Record<string, unknown>): TModel {
    const instance = new this.modelCtor() as TModel
    return hydrateRow(this.schema, row, instance as object) as TModel
  }
}
