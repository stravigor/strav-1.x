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
 * `find`, `create`, `update`, etc. read these to know which table to touch
 * and which class to hydrate rows onto.
 *
 * Deferred in this foundation slice (each is its own follow-up):
 *   - Lifecycle hooks (`<resource>.creating` / `.created` / etc. on the
 *     EventBus)
 *   - Soft-delete integration (`.withTrashed()`, `delete()` writing
 *     `deleted_at` instead of dropping the row)
 *   - Relationships + eager loading (`.with('relation')`)
 *   - Pagination helpers (`.paginate` / `.cursorPaginate`)
 *   - The `tx?` parameter for transaction scoping
 */

import { type EventBus, NotFoundError } from '@strav/kernel'
import type { Database, DatabaseExecutor, PostgresDatabase } from '../database.ts'
import type { Schema } from '../schema/types.ts'
import { hydrateRow, type ModelClass } from './model.ts'
import { QueryBuilder } from './query_builder.ts'
import {
  emitDeleteById,
  emitFindById,
  emitFindMany,
  emitInsert,
  emitUpdateById,
} from './sql_emitter.ts'

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

  async find(id: string | number): Promise<TModel | null> {
    const { sql, params } = emitFindById(this.schema, id)
    const row = await this.executor().queryOne<Record<string, unknown>>(sql, params)
    return row ? this.hydrate(row) : null
  }

  async findOrFail(id: string | number): Promise<TModel> {
    const found = await this.find(id)
    if (!found) {
      throw new NotFoundError(`${this.schema.name} "${id}" not found.`, {
        code: `${this.schema.name}.not-found`,
        context: { id },
      })
    }
    return found
  }

  async findMany(ids: readonly (string | number)[]): Promise<TModel[]> {
    if (ids.length === 0) return []
    const { sql, params } = emitFindMany(this.schema, ids)
    const rows = await this.executor().query<Record<string, unknown>>(sql, params)
    return rows.map((r) => this.hydrate(r))
  }

  async first(): Promise<TModel | null> {
    return this.query().first()
  }

  async all(): Promise<TModel[]> {
    return this.query().get()
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  async create(attrs: Partial<TModel>): Promise<TModel> {
    await this.emit<RepositoryCreatingEvent<TModel>>('creating', {
      resource: this.schema.name,
      attrs,
    })
    const { sql, params } = emitInsert(this.schema, attrs as Record<string, unknown>)
    const row = await this.executor().queryOne<Record<string, unknown>>(sql, params)
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

  async update(model: TModel, changes: Partial<TModel>): Promise<TModel> {
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
    const row = await this.executor().queryOne<Record<string, unknown>>(sql, params)
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

  async delete(model: TModel): Promise<void> {
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
    await this.executor().execute(sql, params)
    await this.emit<RepositoryDeletedEvent<TModel>>('deleted', {
      resource: this.schema.name,
      model,
    })
  }

  // ─── Lifecycle helper ──────────────────────────────────────────────────────

  /**
   * Emit `<resource>.<verb>` on the bus when one was wired. No-op when the
   * Repository was constructed without an EventBus — keeps tests + simple
   * scripts working without the wiring ceremony.
   *
   * `.<verb>ing` events are cancelable; the EventBus rejects on the first
   * listener throw, which propagates out of `create` / `update` / `delete`
   * before any SQL runs. `.<verb>ed` events fire AFTER the SQL succeeds;
   * listener throws are caught by the bus's default handler and logged.
   */
  private async emit<P>(verb: string, payload: P): Promise<void> {
    if (!this.events) return
    await this.events.emit(`${this.schema.name}.${verb}`, payload)
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /** Fluent query builder scoped to this repository's schema. */
  query(): QueryBuilder<TModel> {
    return new QueryBuilder<TModel>(this.schema, this.executor(), this.modelCtor)
  }

  // ─── Aggregates ────────────────────────────────────────────────────────────

  async exists(where: Partial<TModel>): Promise<boolean> {
    return this.query()
      .where(where as Record<string, unknown>)
      .exists()
  }

  async count(where?: Partial<TModel>): Promise<number> {
    const q = where ? this.query().where(where as Record<string, unknown>) : this.query()
    return q.count()
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The DatabaseExecutor to use for queries. PostgresDatabase implements
   * DatabaseExecutor structurally; this seam exists so a future `tx?`
   * parameter on the public methods can route through a transaction-scoped
   * executor without each method handling the branch.
   */
  protected executor(): DatabaseExecutor {
    return this.db as unknown as Database
  }

  protected hydrate(row: Record<string, unknown>): TModel {
    const instance = new this.modelCtor() as TModel
    return hydrateRow(this.schema, row, instance as object) as TModel
  }
}
