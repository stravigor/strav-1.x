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

import { NotFoundError } from '@strav/kernel'
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

export abstract class Repository<TModel extends object> {
  /** The schema this Repository operates on. Subclasses MUST set this. */
  static readonly schema: Schema
  /** The Model class to hydrate rows onto. Subclasses MUST set this. */
  static readonly model: ModelClass

  protected readonly schema: Schema
  protected readonly modelCtor: ModelClass<TModel & { constructor: ModelClass<TModel> }>

  constructor(protected readonly db: PostgresDatabase) {
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
    const { sql, params } = emitInsert(this.schema, attrs as Record<string, unknown>)
    const row = await this.executor().queryOne<Record<string, unknown>>(sql, params)
    if (!row) {
      throw new Error(
        `Repository.create("${this.schema.name}"): RETURNING * did not produce a row.`,
      )
    }
    return this.hydrate(row)
  }

  async update(model: TModel, changes: Partial<TModel>): Promise<TModel> {
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.update("${this.schema.name}"): the model has no \`id\` to update by.`,
      )
    }
    const { sql, params } = emitUpdateById(this.schema, id, changes as Record<string, unknown>)
    const row = await this.executor().queryOne<Record<string, unknown>>(sql, params)
    if (!row) {
      throw new NotFoundError(`${this.schema.name} "${String(id)}" no longer exists.`, {
        code: `${this.schema.name}.not-found`,
        context: { id },
      })
    }
    return this.hydrate(row)
  }

  async delete(model: TModel): Promise<void> {
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.delete("${this.schema.name}"): the model has no \`id\` to delete by.`,
      )
    }
    const { sql, params } = emitDeleteById(this.schema, id)
    await this.executor().execute(sql, params)
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
