/**
 * `QueryBuilder<TModel>` — fluent SELECT for one schema's table.
 *
 * Foundation slice: WHERE / ORDER BY / LIMIT / OFFSET / SELECT — and the
 * terminal methods `get` / `first` / `firstOrFail` / `count` / `exists` /
 * `pluck`. Joins, eager loading, CTEs, soft-delete integration,
 * pagination helpers all land in follow-up cuts.
 *
 * The builder is **immutable per chain**: every modifier returns a fresh
 * QueryBuilder so apps can branch off without mutating shared state.
 *
 * SQL is emitted in `toSql()`; terminal methods compose `toSql()` + the
 * `Database.query/queryOne/execute` call. Tests assert the emitted SQL
 * shape; integration tests against real Postgres are CI's responsibility.
 */

import { NotFoundError } from '@strav/kernel'
import type { DatabaseExecutor } from '../database.ts'
import type { Schema } from '../schema/types.ts'
import type { SchemaRegistry } from '../schema_registry.ts'
import { hydrateRow, type ModelClass } from './model.ts'
import { quoteIdent, schemaHasSoftDelete, selectColumnList } from './sql_emitter.ts'

/** Soft-delete scope applied to the WHERE clause. */
type TrashedScope = 'exclude' | 'include' | 'only'

/** Result of an offset-paginated query. */
export interface PaginatedResult<TModel> {
  /** The rows for this page (already eager-loaded if `.with(...)` was used). */
  data: TModel[]
  /** Total rows matching the query — runs a parallel `COUNT(*)`. */
  total: number
  /** The page number that was requested. */
  page: number
  /** Rows per page that was requested. */
  perPage: number
  /** `Math.ceil(total / perPage)`. */
  totalPages: number
}

export type WhereOperator =
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | 'like'
  | 'ilike'
  | 'in'
  | 'not in'
  | 'is null'
  | 'is not null'

interface WhereClause {
  column: string
  op: WhereOperator
  value: unknown
}

interface OrderClause {
  column: string
  direction: 'asc' | 'desc'
}

export interface BuiltQuery {
  sql: string
  params: unknown[]
}

export class QueryBuilder<TModel extends object = Record<string, unknown>> {
  private readonly wheres: WhereClause[] = []
  private readonly orders: OrderClause[] = []
  private selectColumns: readonly string[] | undefined
  private limitN: number | undefined
  private offsetN: number | undefined
  /**
   * How the builder treats soft-deleted rows. Default `exclude` — when the
   * schema declared `t.softDeletes()`, every WHERE auto-appends
   * `"deleted_at" IS NULL`. `include` (via `.withTrashed()`) skips that
   * predicate; `only` (via `.onlyTrashed()`) flips it to `IS NOT NULL`.
   * No-op on schemas without a `deleted_at` column.
   */
  private trashedScope: TrashedScope = 'exclude'
  /** Relation names requested via `.with(...)` — loaded after the main query. */
  private readonly eagerLoads: string[] = []

  constructor(
    private readonly schema: Schema,
    private readonly db: DatabaseExecutor,
    private readonly modelCtor:
      | ModelClass<TModel & { constructor: ModelClass<TModel> }>
      | undefined,
    private readonly registry?: SchemaRegistry,
  ) {}

  // ─── Modifiers (each returns a fresh builder; chainable) ───────────────────

  /** Select a subset of columns. Default: every schema column (`SELECT *`-ish). */
  select(...columns: string[]): QueryBuilder<TModel> {
    const next = this.clone()
    next.selectColumns = columns
    return next
  }

  /** Equality form: `where('email', 'a@b.com')`. */
  where(column: string, value: unknown): QueryBuilder<TModel>
  /** Operator form: `where('age', '>=', 18)`. */
  where(column: string, op: WhereOperator, value?: unknown): QueryBuilder<TModel>
  /** Object form: `where({ email: 'a@b.com', is_active: true })`. */
  where(criteria: Partial<Record<string, unknown>>): QueryBuilder<TModel>
  where(
    columnOrCriteria: string | Partial<Record<string, unknown>>,
    opOrValue?: unknown,
    maybeValue?: unknown,
  ): QueryBuilder<TModel> {
    const next = this.clone()
    if (typeof columnOrCriteria === 'object' && columnOrCriteria !== null) {
      for (const [k, v] of Object.entries(columnOrCriteria)) {
        next.wheres.push({ column: k, op: '=', value: v })
      }
      return next
    }
    const column = columnOrCriteria
    // Two-arg overload: where(col, value) → equality
    if (maybeValue === undefined && !isOperator(opOrValue)) {
      next.wheres.push({ column, op: '=', value: opOrValue })
      return next
    }
    const op = opOrValue as WhereOperator
    next.wheres.push({ column, op, value: maybeValue })
    return next
  }

  /** `column IN (...vals)`. */
  whereIn(column: string, values: readonly unknown[]): QueryBuilder<TModel> {
    const next = this.clone()
    next.wheres.push({ column, op: 'in', value: values })
    return next
  }
  /** `column NOT IN (...vals)`. */
  whereNotIn(column: string, values: readonly unknown[]): QueryBuilder<TModel> {
    const next = this.clone()
    next.wheres.push({ column, op: 'not in', value: values })
    return next
  }
  /** `column IS NULL`. */
  whereNull(column: string): QueryBuilder<TModel> {
    const next = this.clone()
    next.wheres.push({ column, op: 'is null', value: undefined })
    return next
  }
  /** `column IS NOT NULL`. */
  whereNotNull(column: string): QueryBuilder<TModel> {
    const next = this.clone()
    next.wheres.push({ column, op: 'is not null', value: undefined })
    return next
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): QueryBuilder<TModel> {
    const next = this.clone()
    next.orders.push({ column, direction })
    return next
  }

  limit(n: number): QueryBuilder<TModel> {
    const next = this.clone()
    next.limitN = n
    return next
  }
  offset(n: number): QueryBuilder<TModel> {
    const next = this.clone()
    next.offsetN = n
    return next
  }

  /**
   * Include soft-deleted rows in the result (rows where `deleted_at` is
   * non-null). No-op on schemas without `t.softDeletes()`.
   */
  withTrashed(): QueryBuilder<TModel> {
    const next = this.clone()
    next.trashedScope = 'include'
    return next
  }

  /**
   * Return ONLY soft-deleted rows. Useful for "trash bin" UIs and
   * cleanup queries. Throws if called on a schema without `t.softDeletes()`
   * — the query would always be empty.
   */
  onlyTrashed(): QueryBuilder<TModel> {
    if (!schemaHasSoftDelete(this.schema)) {
      throw new Error(
        `QueryBuilder.onlyTrashed: schema "${this.schema.name}" doesn't declare t.softDeletes() — there's no deleted_at column to filter on.`,
      )
    }
    const next = this.clone()
    next.trashedScope = 'only'
    return next
  }

  /**
   * Eager-load one or more declared relations. After the main query
   * returns, the builder runs ONE additional SELECT per relation
   * (`WHERE fk IN (parent ids)`), groups the children by foreign key,
   * and attaches them to the parents as plain row objects.
   *
   * Requires a `SchemaRegistry` to be wired on the builder (passed via
   * `Repository`'s constructor). `.with()` throws if no registry was
   * provided or if the relation name isn't on this schema.
   *
   * Eager-loaded children come back as plain `Record<string, unknown>`
   * — V1 doesn't hydrate them to Model instances. Apps that need typed
   * children cast: `user.posts as Post[]`. Typed-Model children land
   * with the relations follow-up (needs a Model registry).
   */
  with(...names: string[]): QueryBuilder<TModel> {
    const next = this.clone()
    next.eagerLoads.push(...names)
    return next
  }

  // ─── Build ─────────────────────────────────────────────────────────────────

  /** Compile to `{ sql, params }`. Used by every terminal method. */
  toSql(): BuiltQuery {
    const cols = this.selectColumns
      ? this.selectColumns.map(quoteIdent).join(', ')
      : selectColumnList(this.schema)
    const params: unknown[] = []
    const where = this.compileWhere(params)
    const order = this.compileOrder()
    const tail = `${where}${order}${this.limitN !== undefined ? ` LIMIT ${this.limitN}` : ''}${
      this.offsetN !== undefined ? ` OFFSET ${this.offsetN}` : ''
    }`
    return {
      sql: `SELECT ${cols} FROM ${quoteIdent(this.schema.name)}${tail}`,
      params,
    }
  }

  // ─── Terminals ─────────────────────────────────────────────────────────────

  /** Run the query and return every row hydrated to `TModel`. */
  async get(): Promise<TModel[]> {
    const { sql, params } = this.toSql()
    const rows = await this.db.query<Record<string, unknown>>(sql, params)
    const models = rows.map((row) => this.hydrate(row))
    if (this.eagerLoads.length > 0) await this.loadEager(models)
    return models
  }

  /** First row or null. Implicit `LIMIT 1`. */
  async first(): Promise<TModel | null> {
    const limited = this.limitN === undefined ? this.limit(1) : this
    const { sql, params } = limited.toSql()
    const row = await this.db.queryOne<Record<string, unknown>>(sql, params)
    if (!row) return null
    const model = this.hydrate(row)
    if (this.eagerLoads.length > 0) await this.loadEager([model])
    return model
  }

  /** First row; throws `NotFoundError` when missing. */
  async firstOrFail(): Promise<TModel> {
    const found = await this.first()
    if (!found) {
      throw new NotFoundError(`No "${this.schema.name}" row matched the query.`, {
        code: `${this.schema.name}.not-found`,
      })
    }
    return found
  }

  /**
   * Offset pagination. Runs the main SELECT with `LIMIT perPage OFFSET
   * (page - 1) * perPage` PLUS a parallel `COUNT(*)` for the total.
   * Honors every WHERE / soft-delete predicate; eager-loads via `.with()`
   * run on the page's rows.
   *
   * `page` is 1-based. Apps typically read it from a query string +
   * clamp to >= 1 before calling.
   *
   * Cursor pagination (`.cursorPaginate(...)`) is a follow-up — it's
   * faster on large tables and stable under inserts, but needs a
   * sort-key contract.
   */
  async paginate({
    page,
    perPage,
  }: {
    page: number
    perPage: number
  }): Promise<PaginatedResult<TModel>> {
    if (!Number.isInteger(page) || page < 1) {
      throw new Error(`QueryBuilder.paginate: page must be a positive integer, got ${page}.`)
    }
    if (!Number.isInteger(perPage) || perPage < 1) {
      throw new Error(`QueryBuilder.paginate: perPage must be a positive integer, got ${perPage}.`)
    }
    const offset = (page - 1) * perPage
    const sized = this.limit(perPage).offset(offset)
    const [data, total] = await Promise.all([sized.get(), this.count()])
    return {
      data,
      total,
      page,
      perPage,
      totalPages: total === 0 ? 0 : Math.ceil(total / perPage),
    }
  }

  /** Aggregate row count for the matched set (ignores LIMIT / OFFSET / SELECT). */
  async count(): Promise<number> {
    const params: unknown[] = []
    const where = this.compileWhere(params)
    const { sql } = {
      sql: `SELECT COUNT(*) AS count FROM ${quoteIdent(this.schema.name)}${where}`,
    }
    const row = await this.db.queryOne<{ count: number | string }>(sql, params)
    return row ? Number(row.count) : 0
  }

  /** True when the matched set is non-empty (cheaper than count()). */
  async exists(): Promise<boolean> {
    const params: unknown[] = []
    const where = this.compileWhere(params)
    const sql = `SELECT 1 FROM ${quoteIdent(this.schema.name)}${where} LIMIT 1`
    const row = await this.db.queryOne(sql, params)
    return row !== null
  }

  /** Project one column. */
  async pluck<T = unknown>(column: string): Promise<T[]> {
    const params: unknown[] = []
    const where = this.compileWhere(params)
    const order = this.compileOrder()
    const sql = `SELECT ${quoteIdent(column)} FROM ${quoteIdent(this.schema.name)}${where}${order}${
      this.limitN !== undefined ? ` LIMIT ${this.limitN}` : ''
    }${this.offsetN !== undefined ? ` OFFSET ${this.offsetN}` : ''}`
    const rows = await this.db.query<Record<string, unknown>>(sql, params)
    return rows.map((r) => r[column] as T)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private hydrate(row: Record<string, unknown>): TModel {
    if (!this.modelCtor) return row as TModel
    const instance = new this.modelCtor() as TModel
    return hydrateRow(this.schema, row, instance as object) as TModel
  }

  /**
   * Eager-load every relation requested via `.with(...)` onto the given
   * parent rows. One SELECT per relation, batched via `WHERE fk IN
   * (parentIds)`. Children attach as plain `Record<string, unknown>`
   * (hasMany → array; belongsTo → single object or null).
   *
   * Throws if the builder has no `SchemaRegistry` wired or if a requested
   * relation name isn't on the schema. Apps reach for this via Repository
   * (which threads the registry through automatically).
   */
  private async loadEager(parents: TModel[]): Promise<void> {
    if (parents.length === 0) return
    if (!this.registry) {
      throw new Error(
        `QueryBuilder.with("${this.schema.name}"): eager loading requires a SchemaRegistry — construct the Repository with one (the @inject() flow does this automatically when SchemaRegistry is bound on the container).`,
      )
    }

    for (const name of this.eagerLoads) {
      const relation = this.schema.relations.find((r) => r.name === name)
      if (!relation) {
        throw new Error(
          `QueryBuilder.with: schema "${this.schema.name}" has no relation named "${name}". ` +
            `Declared relations: ${this.schema.relations.map((r) => r.name).join(', ') || '(none)'}.`,
        )
      }

      const target = this.registry.getOrFail(relation.target)

      if (relation.kind === 'hasMany') {
        // Parent's PK (`id`) → child's foreignKey column.
        const parentIds = parents
          .map((p) => (p as Record<string, unknown>).id)
          .filter((id) => id !== undefined && id !== null)
        if (parentIds.length === 0) {
          for (const parent of parents) {
            ;(parent as Record<string, unknown>)[name] = []
          }
          continue
        }
        const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(', ')
        const childSql = `SELECT * FROM ${quoteIdent(target.name)} WHERE ${quoteIdent(relation.foreignKey)} IN (${placeholders})`
        const children = await this.db.query<Record<string, unknown>>(childSql, parentIds)
        const byParent = new Map<unknown, Record<string, unknown>[]>()
        for (const row of children) {
          const fk = row[relation.foreignKey]
          const list = byParent.get(fk) ?? []
          list.push(row)
          byParent.set(fk, list)
        }
        for (const parent of parents) {
          const id = (parent as Record<string, unknown>).id
          ;(parent as Record<string, unknown>)[name] = byParent.get(id) ?? []
        }
      } else {
        // belongsTo: parent's foreignKey column → target's PK (`id`).
        const fkValues = parents
          .map((p) => (p as Record<string, unknown>)[relation.foreignKey])
          .filter((v) => v !== undefined && v !== null)
        if (fkValues.length === 0) {
          for (const parent of parents) {
            ;(parent as Record<string, unknown>)[name] = null
          }
          continue
        }
        const unique = Array.from(new Set(fkValues))
        const placeholders = unique.map((_, i) => `$${i + 1}`).join(', ')
        const targetSql = `SELECT * FROM ${quoteIdent(target.name)} WHERE ${quoteIdent('id')} IN (${placeholders})`
        const rows = await this.db.query<Record<string, unknown>>(targetSql, unique)
        const byId = new Map<unknown, Record<string, unknown>>()
        for (const row of rows) {
          byId.set(row.id, row)
        }
        for (const parent of parents) {
          const fk = (parent as Record<string, unknown>)[relation.foreignKey]
          ;(parent as Record<string, unknown>)[name] = byId.get(fk) ?? null
        }
      }
    }
  }

  private clone(): QueryBuilder<TModel> {
    const next = new QueryBuilder<TModel>(this.schema, this.db, this.modelCtor, this.registry)
    next.wheres.push(...this.wheres)
    next.orders.push(...this.orders)
    next.selectColumns = this.selectColumns
    next.limitN = this.limitN
    next.offsetN = this.offsetN
    next.trashedScope = this.trashedScope
    next.eagerLoads.push(...this.eagerLoads)
    return next
  }

  private compileWhere(params: unknown[]): string {
    const fragments: string[] = []

    // Soft-delete default scope: schemas declared with t.softDeletes() get
    // an automatic `deleted_at IS NULL` predicate unless the caller
    // requested `withTrashed()` (include) or `onlyTrashed()` (only).
    if (this.trashedScope !== 'include' && schemaHasSoftDelete(this.schema)) {
      const op = this.trashedScope === 'only' ? 'IS NOT NULL' : 'IS NULL'
      fragments.push(`${quoteIdent('deleted_at')} ${op}`)
    }

    for (const clause of this.wheres) {
      const ident = quoteIdent(clause.column)
      switch (clause.op) {
        case 'is null':
          fragments.push(`${ident} IS NULL`)
          break
        case 'is not null':
          fragments.push(`${ident} IS NOT NULL`)
          break
        case 'in':
        case 'not in': {
          const values = clause.value as readonly unknown[]
          if (values.length === 0) {
            // `IN ()` is invalid SQL — emit a deterministic always-false / always-true.
            fragments.push(clause.op === 'in' ? 'FALSE' : 'TRUE')
            break
          }
          const placeholders = values
            .map((v) => {
              params.push(v)
              return `$${params.length}`
            })
            .join(', ')
          fragments.push(`${ident} ${clause.op.toUpperCase()} (${placeholders})`)
          break
        }
        default: {
          params.push(clause.value)
          fragments.push(`${ident} ${clause.op.toUpperCase()} $${params.length}`)
        }
      }
    }

    if (fragments.length === 0) return ''
    return ` WHERE ${fragments.join(' AND ')}`
  }

  private compileOrder(): string {
    if (this.orders.length === 0) return ''
    const fragments = this.orders.map((o) => `${quoteIdent(o.column)} ${o.direction.toUpperCase()}`)
    return ` ORDER BY ${fragments.join(', ')}`
  }
}

function isOperator(value: unknown): value is WhereOperator {
  if (typeof value !== 'string') return false
  return (
    value === '=' ||
    value === '<>' ||
    value === '<' ||
    value === '<=' ||
    value === '>' ||
    value === '>=' ||
    value === 'like' ||
    value === 'ilike' ||
    value === 'in' ||
    value === 'not in' ||
    value === 'is null' ||
    value === 'is not null'
  )
}
