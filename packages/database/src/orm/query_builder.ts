/**
 * `QueryBuilder<TModel>` — fluent SELECT for one schema's table.
 *
 * Modifiers: WHERE / ORDER BY / LIMIT / OFFSET / SELECT / `.with(...)`
 * (eager loading via batched SELECTs) / soft-delete scope helpers
 * (`.withTrashed()` / `.onlyTrashed()`). Terminals: `get` / `first` /
 * `firstOrFail` / `count` / `exists` / `pluck` / `paginate({ page,
 * perPage })` / `cursorPaginate({ perPage, after?, before? })` /
 * `chunk(perPage, fn)`.
 *
 * The builder is **immutable per chain**: every modifier returns a fresh
 * QueryBuilder so apps can branch off without mutating shared state.
 *
 * SQL is emitted in `toSql()`; terminal methods compose `toSql()` + the
 * `Database.query/queryOne/execute` call. Tests assert the emitted SQL
 * shape; integration tests against real Postgres are CI's responsibility.
 *
 * CTEs (`.cte` / `.cteRecursive` / `.from(name)`) and union composition
 * (`.union` / `.unionAll`) ship alongside the row-fetching surface;
 * placeholders renumber automatically across sub-bodies. Aggregation
 * terminals (`count` / `exists` / `pluck` / `paginate`) run against
 * the main builder only — they do not include the WITH clause or
 * unions.
 *
 * Cursor pagination + chunk are read-only by design — they require
 * exactly one `.orderBy(col, dir)` to anchor the cursor (the PK is the
 * auto-tiebreaker) and don't compose with `.cte()` / `.union()`.
 *
 * Still deferred:
 *   - Explicit `.join()` / `.leftJoin()` — `.with(...)` covers the
 *     N+1-prevention use case via separate batched SELECTs.
 */

import { type Cipher, NotFoundError } from '@strav/kernel'
import type { DatabaseExecutor } from '../database.ts'
import { findPrimaryKey } from '../ddl/sql_type.ts'
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

/** Options for cursor pagination. `after` and `before` are mutually exclusive. */
export interface CursorPaginateOptions {
  /** Rows per page. Must be a positive integer. */
  perPage: number
  /** Forward cursor — fetch the page AFTER this point. */
  after?: string
  /** Backward cursor — fetch the page BEFORE this point. */
  before?: string
}

/** Result of a cursor-paginated query. */
export interface CursorPaginatedResult<TModel> {
  /** The rows for this page (already eager-loaded if `.with(...)` was used). */
  data: TModel[]
  /** Cursor for the next page; `null` when there's no page after this one. */
  nextCursor: string | null
  /** Cursor for the previous page; `null` when there's no page before this one. */
  prevCursor: string | null
  /** True iff another page exists in the direction the caller requested. */
  hasMore: boolean
}

/** Payload encoded into an opaque cursor string. */
interface CursorPayload {
  /** Sort-key value of the row at the page boundary. */
  v: unknown
  /** Primary-key value — tiebreaker so equal sort values still sort deterministically. */
  i: unknown
}

/** Encode `(sortValue, pkValue)` into an opaque base64url cursor string. */
function encodeCursor(payload: CursorPayload): string {
  const v = payload.v instanceof Date ? payload.v.toISOString() : payload.v
  return Buffer.from(JSON.stringify({ v, i: payload.i }), 'utf8').toString('base64url')
}

/** Decode a cursor string. Throws a descriptive Error on malformed input. */
function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (parsed === null || typeof parsed !== 'object' || !('v' in parsed) || !('i' in parsed)) {
      throw new Error('cursor payload missing "v" or "i" key')
    }
    return parsed as CursorPayload
  } catch (err) {
    throw new Error(
      `QueryBuilder.cursorPaginate: malformed cursor "${cursor}" — ${(err as Error).message}.`,
    )
  }
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

/** Raw SQL body — escape hatch for CTE / union sources that the typed builder can't express. */
export interface RawSqlBody {
  sql: string
  params: readonly unknown[]
}

/** Sub-builder shape accepted by `.cte`, `.cteRecursive`, `.union`, `.unionAll`. */
type SubBuilderBody = QueryBuilder<object> | RawSqlBody

interface WithClause {
  name: string
  recursive: boolean
  body: SubBuilderBody
}

interface UnionClause {
  all: boolean
  body: SubBuilderBody
}

/**
 * Compile a CTE / union body into the shared `params` array. For a
 * `QueryBuilder`, delegate to its `_compile`. For a raw `{ sql, params
 * }`, renumber `$N` placeholders by the current offset so they line up
 * with the accumulator.
 */
function compileSubBody(body: SubBuilderBody, params: unknown[]): string {
  if (body instanceof QueryBuilder) {
    return body._compile(params)
  }
  const offset = params.length
  for (const p of body.params) params.push(p)
  return body.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`)
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
  /** CTE definitions (`.cte` / `.cteRecursive`) — prepended to .get() / .first() / .toSql(). */
  private readonly withs: WithClause[] = []
  /** Union / Union ALL bodies appended after the main SELECT. */
  private readonly unions: UnionClause[] = []
  /** Override for the FROM clause — e.g. `.from('cte_name')` when reading from a CTE. */
  private fromOverride: string | undefined

  constructor(
    private readonly schema: Schema,
    private readonly db: DatabaseExecutor,
    private readonly modelCtor:
      | ModelClass<TModel & { constructor: ModelClass<TModel> }>
      | undefined,
    private readonly registry?: SchemaRegistry,
    private readonly cipher?: Cipher,
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

  /**
   * Override the FROM clause — useful when reading from a CTE you just
   * defined with `.cte(...)`. The SELECT column list still comes from
   * the bound schema, so the CTE body must return rows shaped like the
   * schema (same column names + types) for `.get()` hydration to land
   * correctly. Apps that want to project arbitrary shapes drop to raw
   * `db.query()`.
   *
   * ```ts
   * userRepo.query()
   *   .cte('active', userRepo.query().where('is_active', true))
   *   .from('active')          // SELECT from the CTE, not from "user"
   *   .orderBy('created_at')
   *   .get()
   * ```
   */
  from(tableOrCte: string): QueryBuilder<TModel> {
    const next = this.clone()
    next.fromOverride = tableOrCte
    return next
  }

  /**
   * Attach a Common Table Expression to this query. The CTE body is
   * compiled into the same params accumulator as the main SELECT —
   * placeholders renumber automatically across the WITH + main + union
   * clauses, so apps don't have to manage `$N` ordering manually.
   *
   * Pass either another `QueryBuilder` (typed) or a raw `{ sql, params
   * }` (escape hatch for shapes the builder can't express — e.g.
   * recursive terms that need a JOIN against the CTE itself).
   *
   * Multiple `.cte(...)` calls compose into one comma-separated WITH
   * clause. To read from the CTE in the main query, pair with
   * `.from(name)`.
   *
   * ```ts
   * userRepo.query()
   *   .cte('recent_posts',
   *     postRepo.query().orderBy('created_at', 'desc').limit(100)
   *   )
   *   // … then either select from "user" with a manual reference,
   *   // or `.from('recent_posts')` to read from the CTE itself.
   * ```
   */
  cte(name: string, body: SubBuilderBody): QueryBuilder<TModel> {
    if (!name) throw new Error('QueryBuilder.cte: name must be a non-empty string.')
    const next = this.clone()
    next.withs.push({ name, recursive: false, body })
    return next
  }

  /**
   * `cte()` with the `RECURSIVE` keyword. The body is typically a UNION
   * ALL of an anchor term + a self-referencing recursive term — for
   * the latter, the typed builder can't express the join back to the
   * CTE, so apps pass a raw `{ sql, params }` for that branch (or for
   * the whole body):
   *
   * ```ts
   * userRepo.query().cteRecursive('tree', {
   *   sql: `SELECT id, parent_id, name FROM "category" WHERE parent_id IS NULL
   *         UNION ALL
   *         SELECT c.id, c.parent_id, c.name
   *         FROM "category" c JOIN "tree" t ON c.parent_id = t.id`,
   *   params: [],
   * }).from('tree').get()
   * ```
   *
   * A WITH clause that contains AT LEAST ONE recursive CTE emits the
   * `RECURSIVE` keyword at the WITH-clause level (Postgres semantics —
   * the keyword applies to the whole list).
   */
  cteRecursive(name: string, body: SubBuilderBody): QueryBuilder<TModel> {
    if (!name) throw new Error('QueryBuilder.cteRecursive: name must be a non-empty string.')
    const next = this.clone()
    next.withs.push({ name, recursive: true, body })
    return next
  }

  /**
   * UNION the result of `other` after this builder's SELECT. Both
   * branches are wrapped in parentheses so each side's own ORDER BY /
   * LIMIT applies inside the union, as the SQL spec requires. Multiple
   * `.union(...)` calls compose into a chain (`a UNION b UNION c`).
   *
   * Outer ORDER BY / LIMIT after a union is NOT supported in V1 —
   * modifiers on `this` builder apply to its own SELECT (before the
   * union). To order the combined result, wrap with `.cte('all', a.union(b))
   * .from('all').orderBy(...)`.
   *
   * `count()` / `exists()` / `pluck()` / `paginate()` run against the
   * main builder only and ignore unions.
   */
  union(other: QueryBuilder<object> | RawSqlBody): QueryBuilder<TModel> {
    const next = this.clone()
    next.unions.push({ all: false, body: other })
    return next
  }

  /** UNION ALL form of {@link union}. */
  unionAll(other: QueryBuilder<object> | RawSqlBody): QueryBuilder<TModel> {
    const next = this.clone()
    next.unions.push({ all: true, body: other })
    return next
  }

  // ─── Build ─────────────────────────────────────────────────────────────────

  /** Compile to `{ sql, params }`. Used by every terminal method that returns rows. */
  toSql(): BuiltQuery {
    const params: unknown[] = []
    const sql = this._compile(params)
    return { sql, params }
  }

  /**
   * Internal: compile this builder into `params` and return the SQL
   * string. Cross-instance access — sub-builders passed to `.cte()` /
   * `.union()` call into this on their own instance, sharing the same
   * `params` accumulator so `$N` placeholders renumber across the
   * whole composition.
   */
  _compile(params: unknown[]): string {
    const withClause = this.compileWithClause(params)
    const cols = this.selectColumns
      ? this.selectColumns.map(quoteIdent).join(', ')
      : selectColumnList(this.schema)
    const fromName = this.fromOverride ?? this.schema.name
    const where = this.compileWhere(params)
    const order = this.compileOrder()
    const tail = `${where}${order}${this.limitN !== undefined ? ` LIMIT ${this.limitN}` : ''}${
      this.offsetN !== undefined ? ` OFFSET ${this.offsetN}` : ''
    }`
    const main = `SELECT ${cols} FROM ${quoteIdent(fromName)}${tail}`
    const unions = this.compileUnions(params)
    return `${withClause}${main}${unions}`
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

  /**
   * Cursor pagination — fast at any depth (uses the index, doesn't
   * scan + discard `OFFSET` rows) and stable under inserts/deletes
   * (each row's cursor is intrinsic, not positional).
   *
   * Reads the sort key from a prior `.orderBy(col, dir)` on this builder
   * — exactly one `.orderBy(...)` call is required. The PK is appended
   * as a tiebreaker so two rows sharing the same sort value still
   * order deterministically. Combine with `.where(...)` / soft-delete
   * scope / `.with(...)` as usual.
   *
   * The cursor is an opaque base64url string encoding `(sortValue,
   * pkValue)`. Pass it back as `after` (forward page) or `before`
   * (backward page); the two are mutually exclusive. `nextCursor` /
   * `prevCursor` come back populated when more rows exist in that
   * direction.
   *
   * Detection: we fetch `perPage + 1` rows. If we got that many,
   * `hasMore` is `true` and the extra row is dropped from `data`.
   *
   * ```ts
   * const first = await postRepo.query()
   *   .where('published', true)
   *   .orderBy('created_at', 'desc')
   *   .cursorPaginate({ perPage: 20 })
   *
   * const next = await postRepo.query()
   *   .where('published', true)
   *   .orderBy('created_at', 'desc')
   *   .cursorPaginate({ perPage: 20, after: first.nextCursor! })
   * ```
   *
   * V1 boundaries: cursor pagination does NOT compose with `.cte(...)`
   * / `.union(...)` — throws if either is set. Use offset pagination
   * (`.paginate(...)`) for those cases.
   */
  async cursorPaginate(opts: CursorPaginateOptions): Promise<CursorPaginatedResult<TModel>> {
    const { perPage, after, before } = opts
    if (!Number.isInteger(perPage) || perPage < 1) {
      throw new Error(
        `QueryBuilder.cursorPaginate: perPage must be a positive integer, got ${perPage}.`,
      )
    }
    if (after !== undefined && before !== undefined) {
      throw new Error('QueryBuilder.cursorPaginate: pass `after` OR `before`, not both.')
    }
    if (this.withs.length > 0 || this.unions.length > 0) {
      throw new Error(
        'QueryBuilder.cursorPaginate: cursor pagination does not compose with `.cte()` / `.union()` in V1. Use `.paginate({ page, perPage })` instead.',
      )
    }
    if (this.orders.length !== 1) {
      throw new Error(
        `QueryBuilder.cursorPaginate: requires exactly one .orderBy(col, dir) call — got ${this.orders.length}.`,
      )
    }
    const order = this.orders[0] as OrderClause
    const sortCol = order.column
    const direction = order.direction
    const pkName = findPrimaryKey(this.schema).name

    // Backward pagination reverses the comparison + the ORDER BY. We
    // run the underlying query in reversed order, then re-reverse the
    // result so the caller still sees the natural sort order.
    const reversed = before !== undefined
    const cursor = after ?? before
    const decoded = cursor !== undefined ? decodeCursor(cursor) : null
    // Tuple comparison: forward+desc → `<`, forward+asc → `>`,
    // backward+desc → `>`, backward+asc → `<`.
    const cmpOp = (() => {
      if (decoded === null) return null
      const forward = !reversed
      const desc = direction === 'desc'
      if (forward) return desc ? '<' : '>'
      return desc ? '>' : '<'
    })()

    const params: unknown[] = []
    const baseWhere = this.compileWhere(params)
    let where = baseWhere
    if (decoded !== null && cmpOp !== null) {
      params.push(decoded.v)
      params.push(decoded.i)
      const tupleFrag = `(${quoteIdent(sortCol)}, ${quoteIdent(pkName)}) ${cmpOp} ($${params.length - 1}, $${params.length})`
      where = baseWhere === '' ? ` WHERE ${tupleFrag}` : `${baseWhere} AND ${tupleFrag}`
    }
    const effectiveDir = reversed
      ? direction === 'desc'
        ? 'ASC'
        : 'DESC'
      : direction.toUpperCase()
    const orderSql = ` ORDER BY ${quoteIdent(sortCol)} ${effectiveDir}, ${quoteIdent(pkName)} ${effectiveDir}`
    const cols = this.selectColumns
      ? this.selectColumns.map(quoteIdent).join(', ')
      : selectColumnList(this.schema)
    const sql = `SELECT ${cols} FROM ${quoteIdent(this.schema.name)}${where}${orderSql} LIMIT ${perPage + 1}`

    const rows = await this.db.query<Record<string, unknown>>(sql, params)
    const hasMore = rows.length > perPage
    const page = hasMore ? rows.slice(0, perPage) : rows
    if (reversed) page.reverse()

    const models = page.map((row) => this.hydrate(row))
    if (this.eagerLoads.length > 0) await this.loadEager(models)

    // Cursor at the page boundary: for forward pages, nextCursor = last
    // row; prevCursor = first row. Reversed: nextCursor = last row in
    // restored natural order; prevCursor = first row.
    const first = page[0]
    const last = page[page.length - 1]
    const cursorOf = (row: Record<string, unknown> | undefined) =>
      row === undefined ? null : encodeCursor({ v: row[sortCol], i: row[pkName] })

    return {
      data: models,
      // Forward: hasMore tells us if there's another page in the
      // forward direction. Backward: hasMore tells us if there's
      // another page going backward — i.e. there's a PREV cursor.
      hasMore,
      nextCursor:
        !reversed && hasMore
          ? cursorOf(last)
          : reversed && first !== undefined
            ? cursorOf(first)
            : null,
      prevCursor:
        reversed && hasMore
          ? cursorOf(first)
          : !reversed && first !== undefined && decoded !== null
            ? cursorOf(first)
            : null,
    }
  }

  /**
   * Walk the entire result set in pages of `perPage`, calling `fn` for
   * each page. Cursor-paginated under the hood — safe on tables of any
   * size; no `OFFSET` scan + discard, stable under concurrent
   * inserts.
   *
   * `fn` receives each page's rows. If it returns `false`, iteration
   * stops cleanly. Throws propagate (the chunk doesn't catch).
   * Returns the total number of rows processed.
   *
   * Requires exactly one `.orderBy(col, dir)` for the cursor — same
   * contract as `.cursorPaginate`.
   *
   * ```ts
   * await postRepo.query()
   *   .where('archived', false)
   *   .orderBy('id')
   *   .chunk(500, async (posts) => {
   *     for (const post of posts) await reindex(post)
   *   })
   * ```
   */
  async chunk(
    perPage: number,
    // biome-ignore lint/suspicious/noConfusingVoidType: `void | false` is the intended sugar — return false to stop, anything else (including no return) continues.
    fn: (rows: TModel[]) => void | false | Promise<void | false>,
  ): Promise<number> {
    let cursor: string | undefined
    let total = 0
    for (;;) {
      const page: CursorPaginatedResult<TModel> = await this.cursorPaginate({
        perPage,
        after: cursor,
      })
      if (page.data.length === 0) break
      const result = await fn(page.data)
      total += page.data.length
      if (result === false) break
      if (!page.hasMore || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return total
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
    return hydrateRow(this.schema, row, instance as object, this.cipher) as TModel
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
    const next = new QueryBuilder<TModel>(
      this.schema,
      this.db,
      this.modelCtor,
      this.registry,
      this.cipher,
    )
    next.wheres.push(...this.wheres)
    next.orders.push(...this.orders)
    next.selectColumns = this.selectColumns
    next.limitN = this.limitN
    next.offsetN = this.offsetN
    next.trashedScope = this.trashedScope
    next.eagerLoads.push(...this.eagerLoads)
    next.withs.push(...this.withs)
    next.unions.push(...this.unions)
    next.fromOverride = this.fromOverride
    return next
  }

  /**
   * Build the `WITH [RECURSIVE] a AS (...), b AS (...)` prefix.
   * Compiles each CTE body into the shared `params` array. Emits
   * `RECURSIVE` at the WITH level if any CTE in the list is recursive
   * (Postgres treats the keyword as list-scoped).
   */
  private compileWithClause(params: unknown[]): string {
    if (this.withs.length === 0) return ''
    const parts = this.withs.map((w) => {
      const body = compileSubBody(w.body, params)
      return `${quoteIdent(w.name)} AS (${body})`
    })
    const recursive = this.withs.some((w) => w.recursive) ? 'RECURSIVE ' : ''
    return `WITH ${recursive}${parts.join(', ')} `
  }

  /**
   * Append `UNION [ALL] (other)` for each recorded union. Each branch
   * is parenthesized so its own ORDER BY / LIMIT applies inside the
   * branch (required by Postgres when the branches carry their own
   * sort/limit).
   */
  private compileUnions(params: unknown[]): string {
    if (this.unions.length === 0) return ''
    return this.unions
      .map((u) => ` ${u.all ? 'UNION ALL' : 'UNION'} (${compileSubBody(u.body, params)})`)
      .join('')
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
