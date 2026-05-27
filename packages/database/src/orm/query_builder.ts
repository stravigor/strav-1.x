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
import { hydrateRow, type ModelClass } from './model.ts'
import { quoteIdent, selectColumnList } from './sql_emitter.ts'

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

  constructor(
    private readonly schema: Schema,
    private readonly db: DatabaseExecutor,
    private readonly modelCtor:
      | ModelClass<TModel & { constructor: ModelClass<TModel> }>
      | undefined,
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
    return rows.map((row) => this.hydrate(row))
  }

  /** First row or null. Implicit `LIMIT 1`. */
  async first(): Promise<TModel | null> {
    const limited = this.limitN === undefined ? this.limit(1) : this
    const { sql, params } = limited.toSql()
    const row = await this.db.queryOne<Record<string, unknown>>(sql, params)
    return row ? this.hydrate(row) : null
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

  private clone(): QueryBuilder<TModel> {
    const next = new QueryBuilder<TModel>(this.schema, this.db, this.modelCtor)
    next.wheres.push(...this.wheres)
    next.orders.push(...this.orders)
    next.selectColumns = this.selectColumns
    next.limitN = this.limitN
    next.offsetN = this.offsetN
    return next
  }

  private compileWhere(params: unknown[]): string {
    if (this.wheres.length === 0) return ''
    const fragments: string[] = []
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
