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
import type { SchemaRegistry } from '../schema_registry.ts'
import { transactionalStorage } from '../unit_of_work/context.ts'
import { applyCastsToDb } from './decorators.ts'
import { hydrateRow, type ModelClass } from './model.ts'
import { QueryBuilder } from './query_builder.ts'
import {
  emitDeleteById,
  emitInsert,
  emitRestoreById,
  emitSoftDeleteById,
  emitUpdateById,
  schemaHasSoftDelete,
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
  /** True for `forceDelete()` on a soft-deletes schema, false for the soft-delete path. */
  force: boolean
}
export interface RepositoryDeletedEvent<TModel> {
  resource: string
  model: TModel
  force: boolean
}
export interface RepositoryRestoringEvent<TModel> {
  resource: string
  model: TModel
}
export interface RepositoryRestoredEvent<TModel> {
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
   * wiring a bus). `registry` is optional too — apps that use eager
   * loading via `query().with(...)` need it; everything else works without.
   * Both are auto-resolved by the container when the subclass's
   * constructor declares them (the @inject() flow reads paramtypes via
   * reflect-metadata).
   */
  constructor(
    protected readonly db: PostgresDatabase,
    protected readonly events?: EventBus,
    protected readonly registry?: SchemaRegistry,
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
    // Routed through QueryBuilder so the default soft-delete scope applies —
    // `find(id)` returns null for trashed rows by default. Callers that want
    // to read soft-deleted rows reach for `.query().withTrashed()...`.
    return this.query(opts).where('id', id).first()
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
    return this.query(opts).whereIn('id', ids).get()
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
    const dbAttrs = applyCastsToDb(this.modelCtor as object, attrs as Record<string, unknown>)
    const { sql, params } = emitInsert(this.schema, dbAttrs)
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
    const dbChanges = applyCastsToDb(this.modelCtor as object, changes as Record<string, unknown>)
    const { sql, params } = emitUpdateById(this.schema, id, dbChanges)
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

  /**
   * Delete a row. For schemas that declared `t.softDeletes()`, runs
   * `UPDATE … SET deleted_at = now()` so the row stays in the DB but
   * is excluded from default-scoped queries. For schemas without the
   * column, runs a hard `DELETE`. Apps that want a hard delete on a
   * soft-deletes schema reach for `forceDelete(model)`.
   */
  async delete(model: TModel, opts?: RepositoryScope): Promise<TModel | undefined> {
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.delete("${this.schema.name}"): the model has no \`id\` to delete by.`,
      )
    }
    const soft = schemaHasSoftDelete(this.schema)
    await this.emit<RepositoryDeletingEvent<TModel>>('deleting', {
      resource: this.schema.name,
      model,
      force: false,
    })
    if (soft) {
      const { sql, params } = emitSoftDeleteById(this.schema, id)
      const row = await this.executor(opts).queryOne<Record<string, unknown>>(sql, params)
      if (!row) {
        throw new NotFoundError(`${this.schema.name} "${String(id)}" no longer exists.`, {
          code: `${this.schema.name}.not-found`,
          context: { id },
        })
      }
      const trashed = this.hydrate(row)
      await this.emit<RepositoryDeletedEvent<TModel>>('deleted', {
        resource: this.schema.name,
        model: trashed,
        force: false,
      })
      return trashed
    }
    const { sql, params } = emitDeleteById(this.schema, id)
    await this.executor(opts).execute(sql, params)
    await this.emit<RepositoryDeletedEvent<TModel>>('deleted', {
      resource: this.schema.name,
      model,
      force: false,
    })
  }

  /**
   * Always hard-delete, even on soft-deletes schemas. Fires the same
   * `.deleting` / `.deleted` events with `force: true` so listeners can
   * distinguish the two paths.
   */
  async forceDelete(model: TModel, opts?: RepositoryScope): Promise<void> {
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.forceDelete("${this.schema.name}"): the model has no \`id\` to delete by.`,
      )
    }
    await this.emit<RepositoryDeletingEvent<TModel>>('deleting', {
      resource: this.schema.name,
      model,
      force: true,
    })
    const { sql, params } = emitDeleteById(this.schema, id)
    await this.executor(opts).execute(sql, params)
    await this.emit<RepositoryDeletedEvent<TModel>>('deleted', {
      resource: this.schema.name,
      model,
      force: true,
    })
  }

  /**
   * Restore a soft-deleted row — `UPDATE … SET deleted_at = NULL`. Fires
   * cancelable `<resource>.restoring` + post `<resource>.restored`.
   * Throws on schemas without `t.softDeletes()`.
   */
  async restore(model: TModel, opts?: RepositoryScope): Promise<TModel> {
    if (!schemaHasSoftDelete(this.schema)) {
      throw new Error(
        `Repository.restore("${this.schema.name}"): schema doesn't declare t.softDeletes() — nothing to restore.`,
      )
    }
    const id = (model as Record<string, unknown>).id
    if (id === undefined) {
      throw new Error(
        `Repository.restore("${this.schema.name}"): the model has no \`id\` to restore by.`,
      )
    }
    await this.emit<RepositoryRestoringEvent<TModel>>('restoring', {
      resource: this.schema.name,
      model,
    })
    const { sql, params } = emitRestoreById(this.schema, id)
    const row = await this.executor(opts).queryOne<Record<string, unknown>>(sql, params)
    if (!row) {
      throw new NotFoundError(`${this.schema.name} "${String(id)}" no longer exists.`, {
        code: `${this.schema.name}.not-found`,
        context: { id },
      })
    }
    const restored = this.hydrate(row)
    await this.emit<RepositoryRestoredEvent<TModel>>('restored', {
      resource: this.schema.name,
      model: restored,
    })
    return restored
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
    return new QueryBuilder<TModel>(this.schema, this.executor(opts), this.modelCtor, this.registry)
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
    // hydrateRow applies @cast `fromDb` transforms when the target's
    // constructor carries cast metadata — Repository doesn't repeat the
    // pass here.
    return hydrateRow(this.schema, row, instance as object) as TModel
  }
}
