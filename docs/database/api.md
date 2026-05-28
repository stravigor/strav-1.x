# @strav/database — API Reference

> **Status:** Reflects what's implemented as of M2 — Database wrapper, DatabaseProvider, Schema DSL (including `t.softDeletes()` / `t.hasMany()` / `t.belongsTo()` / `t.encrypted()`), SchemaRegistry, MigrationRunner, Model with `@hidden` / `@cast` / `@ulid` / `@encrypt` decorators, Repository<T> (lifecycle events + `{ tx? }` opt-in / ALS auto-routing + soft-delete + restore/forceDelete), QueryBuilder (`.with(...)` eager loading + soft-delete scopes + `.paginate({ page, perPage })`), SQL emitter, DDL emitters (including indexes + renames), schema-diff generator (additive + destructive with `allowDrop` + `renames`), multi-tenancy (DDL + TenantManager.withTenant / withoutTenant / withTenantLock / withLock built on UoW), `UnitOfWork.run(fn)` with queue-until-commit lifecycle events, boot-time `validateTenantRegistry` + `emitTenantIdFunction`, Cipher + EncryptionProvider. Explicit `.join()` / migration builder DSL / `generateMigration` type-change detection all land in follow-up cuts.

## `Database` / `PostgresDatabase`

```ts
interface Database extends DatabaseExecutor {
  transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>
  close(options?: { timeout?: number }): Promise<void>
  raw(): SQL                            // escape hatch — underlying Bun.SQL
}

interface DatabaseExecutor {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
  queryOne<T>(sql: string, params?: readonly unknown[]): Promise<T | null>
  execute(sql: string, params?: readonly unknown[]): Promise<number>  // affected rows
}
```

`PostgresDatabase` is the concrete impl backed by `Bun.SQL`. Apps resolve it via the container (`app.resolve(PostgresDatabase)` or `app.resolve<Database>('database')`). The interface is what every higher layer composes against — the migration runner takes a `Database`, future Repository / query-builder take a `Database`, so a custom impl (read replica routing, query logging wrapper) drops in without changes elsewhere.

`raw()` returns the underlying `Bun.SQL` — use it for tagged-template queries, CTEs, or vendor features the wrapper doesn't surface yet.

### Transactions

```ts
const result = await db.transaction(async (tx) => {
  await tx.execute('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from])
  await tx.execute('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to])
  return { transferred: amount }
})
```

The callback receives a `DatabaseExecutor` scoped to the transaction. Returning resolves and commits; throwing rolls back.

## `DatabaseProvider`

`name = 'database'`, `dependencies = ['config']`. Binds:

- `PostgresDatabase` (singleton, factory reads `config.database`)
- `'database'` string-key alias (same singleton)
- `AdminDatabase` (singleton, opt-in) — bound ONLY when `config.database.admin.url` is set; `'database.admin'` string-key alias as well

### `boot()`

By default a no-op (`lazyConnect: true`). Pass `lazyConnect: false` in config to call `Bun.SQL.connect()` at boot, so misconfig / network failures surface immediately instead of on the first query.

### `shutdown()`

Calls `db.close({ timeout: config.database.shutdownTimeoutSeconds ?? 5 })` on the primary pool, then on `AdminDatabase` if bound. Both wrapped in try/catch — never throws past the kernel boundary.

### Config slice

```ts
interface DatabaseConfigShape {
  url: string                          // postgres://user:pass@host:5432/db
  idleTimeout?: number                 // seconds; Bun.SQL default
  max?: number                         // pool size; Bun.SQL default
  lazyConnect?: boolean                // default true
  shutdownTimeoutSeconds?: number      // default 5
  admin?: {                            // optional BYPASSRLS pool
    url: string
    idleTimeout?: number
    max?: number
  }
}
```

Missing `url` throws `ConfigError` at the first `app.resolve(PostgresDatabase)` call (which is `boot()` itself when `lazyConnect: false`; first request when lazy). Omitting the `admin` slice means `AdminDatabase` simply isn't bound — `app.has(AdminDatabase)` honestly reports `false`, and `TenantManager.withoutTenant` / `withLock` fall back to using the primary pool. See `guides/multi_tenancy.md#two-postgres-roles` for the two-role setup.

## `defineSchema` + `Archetype`

```ts
function defineSchema(
  name: string,
  archetype: Archetype,
  build: (t: SchemaBuilder) => void,
  options?: SchemaTenancy,
): Schema

enum Archetype {
  Entity         // has identity, mutable
  Attribute      // owned by another entity
  Reference      // lookup table
  Event          // append-only, immutable
  Configuration  // singleton settings
}

interface SchemaTenancy {
  tenantRegistry?: boolean    // this IS the tenant table
  tenanted?: boolean          // RLS-scoped to current tenant (mutually exclusive)
}
```

Validates `name` is snake_case (table-name shape) and that `tenantRegistry` + `tenanted` aren't both set. Returns a deep-frozen `Schema`.

## `Schema`

```ts
interface Schema {
  readonly name: string
  readonly archetype: Archetype
  readonly fields: readonly SchemaField[]
  readonly tenancy: SchemaTenancy
}
```

Immutable. `fields` preserves declaration order so generated SQL is auditable.

### `SchemaField` (discriminated union)

| `kind` | Extra fields |
|---|---|
| `'id'` | (ULID by default) |
| `'uuid'` | — |
| `'bigSerial'` | (auto-increment bigint) |
| `'tenantedBigSerial'` | (per-tenant auto-increment `bigint` — on `tenanted: true` schemas the emitter wires a composite `(tenant_id, id)` PK + `BEFORE INSERT` trigger + shared counter table) |
| `'string'` | `max: number` (default 255) |
| `'text'` | — |
| `'integer'` | — |
| `'boolean'` | — |
| `'decimal'` | `precision: number`, `scale: number` |
| `'json'` | — |
| `'timestamp'` | `withTimezone: boolean` (default true) |
| `'enum'` | `values: readonly string[]` |
| `'reference'` | `references: string` (target table name), `onDelete: 'cascade' \| 'set null' \| 'restrict' \| 'no action'` |
| `'encrypted'` | `bytea` in Postgres; declare a Model `@encrypt` field of type `string` to round-trip via the Cipher. |

Every field also has `nullable: boolean`, `unique: boolean`, `hasDefault: boolean`, `default: unknown`, `order: number`.

## `SchemaBuilder` (the `t` argument)

Identity:

```ts
t.id()                                   // ULID, name 'id'
t.uuid()                                 // UUID variant
t.bigSerial()                            // auto-increment bigint
t.tenantedBigSerial()                    // per-tenant auto-increment bigint (composite PK + trigger; tenanted-only)
```

`t.serial()` (32-bit int) is intentionally not provided — bigint-by-default avoids the painful overflow migration that 32-bit serial PKs eventually force. `t.tenantedBigSerial()` on a `tenanted: true` schema emits the full per-tenant sequencing layer: column as `bigint NOT NULL DEFAULT 0`, composite `PRIMARY KEY (tenant_id, id)`, a `BEFORE INSERT` trigger that allocates the next per-tenant id from `_strav_tenant_sequences`. On a non-tenanted schema, `t.tenantedBigSerial()` degrades to just `bigint NOT NULL DEFAULT 0` (no trigger / composite PK / RLS). Prefer `t.id()` (ULID) when you don't need per-tenant numeric ids — globally unique, no trigger.

Scalars:

```ts
t.string('email').max(320)
t.text('body')
t.integer('count')
t.boolean('is_active')
t.decimal('amount', 12, 2)
t.json<MyShape>('metadata')
t.timestamp('paid_at', { withTimezone: false })
t.enum('status', ['draft', 'paid', 'refunded'])
t.reference('user_id').to(userSchema).onDelete('cascade')
t.encrypted('ssn')
```

Modifiers (chainable on any builder):

```ts
.nullable()      // allow NULL (default is NOT NULL)
.notNull()       // explicit NOT NULL — for clarity
.unique()        // add UNIQUE constraint
.default(value)  // literal value or { sql: '...' } for SQL expressions
```

Composites:

```ts
t.timestamps()    // adds created_at + updated_at, both default now()
t.softDeletes()   // adds nullable deleted_at
```

Both composites are idempotent — calling twice is a no-op.

## `SchemaRegistry`

```ts
class SchemaRegistry {
  register(schema: Schema): this
  registerAll(schemas: readonly Schema[]): this
  discover(pattern: string | string[], options?: { cwd?: string }): Promise<this>
  get(name: string): Schema | undefined
  getOrFail(name: string): Schema        // throws ConfigError on miss
  has(name: string): boolean
  all(): readonly Schema[]
  clear(): void                          // test helper
}

function isSchema(value: unknown): value is Schema
```

Apps register schemas explicitly (`register` / `registerAll`) or via auto-discovery (`discover(pattern)` uses `Bun.Glob` + dynamic `import()` to scan files, then registers every export that satisfies `isSchema`). `cwd` defaults to `process.cwd()`. Re-exports of the same Schema instance are deduplicated by object identity; different schemas with the same name still throw `ConfigError` — that's programmer error. Files exporting no schemas are silently skipped. `isSchema` is exported for hand-rolled discovery loops.

```ts
// Typical SchemasProvider boot:
await app.resolve(SchemaRegistry).discover('database/schemas/**/*.ts')
```

## `Migration`

```ts
interface Migration {
  readonly name: string
  up(db: DatabaseExecutor): Promise<void>
  down(db: DatabaseExecutor): Promise<void>
}
```

The runner sorts by `name`. Convention: `YYYYMMDDHHMMSS_short_description`.

## `MigrationRunner`

```ts
class MigrationRunner {
  constructor(db: Database)

  register(migration: Migration): this
  registerAll(migrations: readonly Migration[]): this
  list(): readonly Migration[]

  ensureTrackingTable(): Promise<void>
  migrate(): Promise<{ applied: readonly string[]; batch: number }>
  rollback(): Promise<{ rolled_back: readonly string[]; batch: number }>
  status(): Promise<{ applied: readonly AppliedMigration[]; pending: readonly string[] }>
}

interface AppliedMigration {
  name: string
  batch: number
  applied_at: Date
}
```

### Tracking table

`_strav_migrations(name text PK, batch integer, applied_at timestamptz)`. Created lazily by `ensureTrackingTable()`, which every public method calls.

### Batching

Every migration applied in one `migrate()` call shares a batch number. `rollback()` undoes one batch — the most-recently-applied set — in reverse alphabetical order.

### Transactional boundaries

Each migration's `up()` / `down()` runs in its own transaction along with the tracking-table insert/delete — so the tracking row only lands when the migration body commits. The overall `migrate()` call is **not** one transaction: per-migration boundaries mean partial progress is recoverable, and Postgres DDL inside one big transaction can lock the entire schema while it runs.

### What's NOT here

- **Schema-diff migration generator** — `bun strav make:migration` will compare a registered schema against the DB and emit SQL. Lands as a separate slice; for now apps hand-write migrations.
- **Console commands** (`bun strav db:migrate`, etc.) — land with `@strav/cli`'s db integration.
- **Seeders** — same milestone as the console commands.

## Testing

The package ships an `InMemoryDatabase` stub for unit-testing the runner without Postgres (see `packages/database/tests/in_memory_database.ts`). It simulates the tracking-table queries the runner emits and records every other SQL string so tests can assert what a migration tried to run.

Full Postgres integration tests need an actual database — those land with CI setup, separately from the package's unit suite.

## `Model`

```ts
class Model {
  static readonly schema: Schema | undefined   // subclasses MUST set
  toJSON(): Record<string, unknown>            // omits @hidden fields
}

interface ModelClass<T extends object = Model> {
  schema: Schema
  new (): T
}

function hydrateRow<T extends object>(schema: Schema, row, target: T): T
function isModelClass(value: unknown): value is ModelClass
```

Subclasses declare `static schema = userSchema` and add typed fields. `hydrateRow` copies schema-declared columns from a DB row onto a fresh instance; the `Repository` calls it internally on every find/create/update.

### `@hidden` — omit from `toJSON()`

```ts
import { hidden, Model } from '@strav/database'

class User extends Model {
  static schema = userSchema
  email!: string
  @hidden password_hash!: string
}

JSON.stringify(new User())   // ← never includes `password_hash`
```

Subclasses inherit `@hidden` fields. Subclasses adding their own `@hidden` get their own metadata set (parent's set stays untouched). `hiddenFieldsOf(ModelClass)` returns the readonly Set for runtime inspection. See [`guides/model_decorators.md`](./guides/model_decorators.md).

### `@cast` — bidirectional type coercion

Maps a column's stored type to/from an in-memory Model type. `fromDb` runs on hydration; `toDb` runs on `create` / `update`.

```ts
import { cast, Model } from '@strav/database'

class Order extends Model {
  static schema = orderSchema
  @cast({
    fromDb: (raw: unknown) => Money.fromString(String(raw)),
    toDb:   (m: unknown) => (m as Money).toString(),
  })
  total!: Money
}
```

Either side is optional. `castFor(ModelClass, fieldName)` and `castsFor(ModelClass)` are the runtime accessors; `applyCastsToDb(ModelClass, attrs)` runs the `toDb` pass on a plain object (used internally by Repository). Same inheritance rules as `@hidden`.

### `@ulid` — auto-generate + validate ULID columns

Mark a Model property as a ULID-shaped string. Extends the auto-PK behavior of `t.id()` to any string column.

```ts
import { ulid, Model } from '@strav/database'

class Job extends Model {
  static schema = jobSchema
  id!: string
  @ulid correlation_id!: string
}

await jobRepo.create({})                 // correlation_id auto-generated
await jobRepo.create({ correlation_id: 'bad' })   // throws ValidationError
```

Semantics: on `create`, absent / `undefined` / `null` fields are auto-filled with a fresh ULID; supplied values are validated. On `update`, supplied values are validated, `null` is forwarded so callers can clear nullable columns, and missing fields are left alone (no auto-generation). Validation failures throw `ValidationError` carrying a field-level `errors` map keyed by the offending column name.

Write-side only — hydration is passthrough (the column is `char(26)` at the DB layer). Runs **before** `@cast` on writes, so casts see the auto-generated string rather than `undefined`. `ulidFieldsOf(ModelClass)` and `applyUlidsToAttrs(ModelClass, attrs, mode)` are the runtime helpers. Same inheritance rules as `@hidden`.

### `@encrypt` — encryption-at-rest

Mark a Model property as encrypted in the DB. Stored as `bytea` (declare with `t.encrypted('field')`); the Model field stays a plain string. Repository runs `Cipher.encrypt` after `@cast.toDb` on writes and `Cipher.decrypt` before `@cast.fromDb` on reads.

```ts
import { encrypt, Model } from '@strav/database'

class User extends Model {
  static schema = userSchema
  id!: string
  @encrypt ssn!: string    // bytea in Postgres, string in memory
}
```

Default cipher is `AesGcm256Cipher` (AES-256-GCM, 12-byte random IV per encryption, 128-bit auth tag; storage layout `iv || tag || ciphertext`). Wire via the kernel's `EncryptionProvider`:

```ts
new ConfigProvider({ encryption: { key: env.required('ENCRYPTION_KEY') } }),
new EncryptionProvider(),
```

Keys accept 64-char hex / base64-decoding-to-32-bytes / `Uint8Array`. Bad keys / missing config throw `ConfigError` at boot. A Repository whose Model has `@encrypt` fields without an `EncryptionProvider` throws on the first `create` / `update` / `find` call. Models without `@encrypt` work fine without an `EncryptionProvider`.

`encryptedFieldsOf(ModelClass)`, `applyEncryptToAttrs(ModelClass, attrs, cipher)`, and `applyDecryptToRow(ModelClass, row, cipher)` are the runtime helpers. Same inheritance rules as `@hidden`.

Deferred: key rotation (single key today), blind-index helpers for searching encrypted columns, per-tenant keys.

## `Repository<TModel>`

Injectable data-access object. Subclasses declare `static schema = …` and `static model = …`; the base resolves them at construction.

```ts
interface RepositoryScope {
  tx?: DatabaseExecutor   // route this call through a transaction
}

abstract class Repository<TModel> {
  static readonly schema: Schema
  static readonly model: ModelClass

  constructor(db: PostgresDatabase, events?: EventBus, registry?: SchemaRegistry)

  find(id, opts?: RepositoryScope): Promise<TModel | null>
  findOrFail(id, opts?: RepositoryScope): Promise<TModel>             // throws NotFoundError
  findMany(ids, opts?: RepositoryScope): Promise<TModel[]>             // empty list short-circuits
  first(opts?: RepositoryScope): Promise<TModel | null>
  all(opts?: RepositoryScope): Promise<TModel[]>

  create(attrs: Partial<TModel>, opts?: RepositoryScope): Promise<TModel>
  update(model: TModel, changes: Partial<TModel>, opts?: RepositoryScope): Promise<TModel>
  /** Soft-deletes on `t.softDeletes()` schemas (returns the trashed Model); hard-deletes otherwise. */
  delete(model: TModel, opts?: RepositoryScope): Promise<TModel | undefined>
  /** Always hard-deletes, even on soft-deletes schemas. Event payload carries `force: true`. */
  forceDelete(model: TModel, opts?: RepositoryScope): Promise<void>
  /** Clears `deleted_at`. Throws on schemas without `t.softDeletes()`. Fires `.restoring` / `.restored`. */
  restore(model: TModel, opts?: RepositoryScope): Promise<TModel>

  query(opts?: RepositoryScope): QueryBuilder<TModel>

  exists(where: Partial<TModel>, opts?: RepositoryScope): Promise<boolean>
  count(where?: Partial<TModel>, opts?: RepositoryScope): Promise<number>
}
```

`@inject()`-marked subclasses get all three dependencies resolved via the container — the kernel's `Application` registers `EventBus` as a singleton in its constructor, and apps bind their `SchemaRegistry` via a provider. Subclasses that don't list `EventBus` or `SchemaRegistry` in their constructor (or test code that passes only the db) get a Repository missing those features — `create` / `update` / `delete` still work without `events` (no lifecycle events fire); CRUD still works without `registry` (only `query().with(...)` eager loading throws if attempted).

Every CRUD method takes an optional `{ tx? }` as its final arg. The executor is resolved in this order:

1. **Explicit `opts.tx`** wins.
2. **Ambient `UnitOfWork.run` scope** (via AsyncLocalStorage) supplies tx — call sites inside `uow.run(...)` / `withTenant(...)` get tx-routing for free.
3. **`this.db`** — auto-commit per query.

See [`guides/unit_of_work.md`](./guides/unit_of_work.md) for the full transactional flow.

### What's automatic

- **ULID on `create`** when the schema declared `t.id()` and the caller didn't supply `attrs.id`. UUID schemas (`t.uuid()`) get `crypto.randomUUID()`.
- **`updated_at` bump on `update`** when the schema declared `t.timestamps()` and the caller didn't supply `changes.updated_at`.
- **`created_at` / `updated_at` on `create`** — not bound at all when absent from attrs; the schema's `DEFAULT now()` fires. One source of time truth (the DB).
- **`RETURNING *` on `create` / `update`** — Repository hydrates the canonical post-write row.

### Lifecycle events

Every `create` / `update` / `delete` fires a pair of events on the wired `EventBus`:

| Event | Cancelable | Payload |
|---|---|---|
| `<resource>.creating` | ✓ | `{ resource, attrs }` |
| `<resource>.created` | — | `{ resource, model }` |
| `<resource>.updating` | ✓ | `{ resource, model, changes }` |
| `<resource>.updated` | — | `{ resource, model, changes }` |
| `<resource>.deleting` | ✓ | `{ resource, model, force }` |
| `<resource>.deleted` | — | `{ resource, model, force }` |
| `<resource>.restoring` | ✓ | `{ resource, model }` |
| `<resource>.restored` | — | `{ resource, model }` |

`<resource>` is the schema name (snake_case, singular). `.<verb>ing` events run before the SQL — a throwing listener aborts the operation and the SQL never runs. `.<verb>ed` events run after the SQL succeeds; listener throws are caught and logged by the bus's default error handler.

Wildcards work: `events.on('user.*', …)` fires for every user lifecycle event; `events.on('*.created', …)` fires for every resource's create event.

```ts
events.on('user.created', ({ model }: { model: User }) => {
  searchIndex.add(model)
})

events.on('user.deleting', ({ model }: { model: User }) => {
  if (model.is_protected) throw new Error('Cannot delete protected users')
})
```

Payload types are exported from `@strav/database` as `RepositoryCreatingEvent<T>`, `RepositoryCreatedEvent<T>`, `RepositoryUpdatingEvent<T>`, etc.

**Queue-until-commit semantics inside `UnitOfWork.run`.** Outside a UoW scope, post-events (`.created` / `.updated` / `.deleted`) fire immediately after the SQL succeeds. Inside `uow.run(fn)` (or `tenants.withTenant(id, fn)`), they queue and flush after `fn` returns but before the transaction commits — a thrown `fn` drops the queue, so no side effects fire for a transaction that didn't commit. Cancelable `<verb>ing` events always fire immediately regardless. See [`guides/unit_of_work.md`](./guides/unit_of_work.md).

### What's NOT automatic

Explicit `.join()` / `.leftJoin()` is the only remaining QueryBuilder follow-up — see [`guides/repositories.md`](./guides/repositories.md). Everything else (soft-delete, relations + eager loading, offset + cursor pagination, `.chunk()`, CTEs + `WITH RECURSIVE` + `UNION` / `UNION ALL` + `.from(cte_name)`, queue-until-commit, `{ tx? }` routing) is wired.

## `QueryBuilder<TModel>`

Fluent SELECT builder. Returned by `Repository#query()`. Immutable per chain — every modifier returns a fresh builder.

```ts
class QueryBuilder<TModel> {
  select(...columns: string[]): QueryBuilder<TModel>
  where(col, value): QueryBuilder<TModel>
  where(col, op: WhereOperator, value): QueryBuilder<TModel>
  where(criteria: Partial<Record<string, unknown>>): QueryBuilder<TModel>
  whereIn(col, values): QueryBuilder<TModel>
  whereNotIn(col, values): QueryBuilder<TModel>
  whereNull(col): QueryBuilder<TModel>
  whereNotNull(col): QueryBuilder<TModel>
  orderBy(col, dir?: 'asc' | 'desc'): QueryBuilder<TModel>
  limit(n): QueryBuilder<TModel>
  offset(n): QueryBuilder<TModel>
  /** Include soft-deleted rows. Default behavior excludes them on schemas with `t.softDeletes()`. */
  withTrashed(): QueryBuilder<TModel>
  /** Return only soft-deleted rows. Throws on schemas without `t.softDeletes()`. */
  onlyTrashed(): QueryBuilder<TModel>
  /** Eager-load one or more declared relations. Requires a `SchemaRegistry`. */
  with(...names: string[]): QueryBuilder<TModel>

  toSql(): { sql: string; params: unknown[] }

  get(): Promise<TModel[]>
  first(): Promise<TModel | null>             // implicit LIMIT 1
  firstOrFail(): Promise<TModel>
  count(): Promise<number>                     // SELECT COUNT(*) — ignores LIMIT
  exists(): Promise<boolean>                   // SELECT 1 ... LIMIT 1
  pluck<T>(column: string): Promise<T[]>
  /** Offset pagination — main query + COUNT(*) in parallel. */
  paginate(opts: { page: number; perPage: number }): Promise<PaginatedResult<TModel>>
}

interface PaginatedResult<TModel> {
  data: TModel[]            // page rows (with any .with(...) eager-loads applied)
  total: number              // total rows matching the query
  page: number
  perPage: number
  totalPages: number         // Math.ceil(total / perPage)
}

type WhereOperator =
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'like' | 'ilike'
  | 'in' | 'not in'
  | 'is null' | 'is not null'
```

Empty `whereIn`/`whereNotIn` arrays emit `FALSE`/`TRUE` so the query stays valid SQL.

### Soft-delete default scope

When the schema declared `t.softDeletes()`, `QueryBuilder` automatically appends `"deleted_at" IS NULL` to the WHERE clause. Apps don't see soft-deleted rows by accident — `Repository.find(id)` returns `null` for trashed rows, `repo.all()` excludes them, `repo.query().get()` excludes them.

- `withTrashed()` — drop the predicate; query returns all rows including trashed.
- `onlyTrashed()` — flip the predicate to `IS NOT NULL`; query returns only trashed rows. Throws on schemas without `t.softDeletes()`.

The default scope applies to every terminal — `get`, `first`, `firstOrFail`, `count`, `exists`, `pluck` — because they all share `compileWhere`. See [`guides/soft_delete.md`](./guides/soft_delete.md) for the full pattern.

### Eager loading

`.with(...names)` runs the main query, then issues ONE batched SELECT per declared relation (`WHERE fk IN (parent ids)`), and attaches results to parents. This is the N+1 prevention guarantee — for N relations on N parents, you get exactly N+1 queries.

- **`hasMany`** → attaches as an array on each parent (empty for parents with no children).
- **`belongsTo`** → attaches as a single row or `null` (foreign-key values are deduplicated before lookup).
- Children are plain `Record<string, unknown>` — V1 doesn't hydrate them to Model instances. Apps that need typed children cast: `user.posts as Post[]`.
- Requires a `SchemaRegistry` to be wired on the builder via the Repository constructor; `.with()` throws otherwise. The relation name must exist on the schema (declared via `t.hasMany` / `t.belongsTo`).
- `.with(...)` flows through every terminal — `get`, `first`, `firstOrFail`, `paginate`.

See [`guides/relationships.md`](./guides/relationships.md) for the full pattern + the deferred items (typed children, nested loads, `hasOne` / `belongsToMany`, lazy loading, cursor pagination).

### Pagination

`.paginate({ page, perPage })` runs the main SELECT with `LIMIT/OFFSET` AND a parallel `COUNT(*)`, returning the page rows + total. `page` is 1-based; both args must be positive integers. The page result has eager-loads applied — `.with('posts').paginate({...})` populates `posts` on the returned rows.

```ts
const result = await users.query().orderBy('created_at', 'desc').paginate({ page: 1, perPage: 20 })
// { data: User[], total, page, perPage, totalPages }
```

### Cursor pagination + `.chunk()`

```ts
.cursorPaginate(opts: { perPage: number, after?: string, before?: string }): Promise<CursorPaginatedResult<TModel>>
.chunk(perPage: number, fn: (rows: TModel[]) => void | false | Promise<void | false>): Promise<number>
```

- `cursorPaginate` requires exactly one prior `.orderBy(col, dir)` to anchor the cursor. PK is the auto-tiebreaker. Returns `{ data, hasMore, nextCursor, prevCursor }`. Cursors are opaque base64url-encoded `{ v: sortValue, i: pkValue }`. `Date` sort values encode as ISO strings + roundtrip.
- `after` / `before` are mutually exclusive — pass the cursor you got back from a prior call. `before` reverses the direction internally and re-reverses the result so the caller still sees natural order.
- Detection: fetches `perPage + 1` rows; if it got that many, `hasMore` is `true` and the extra is dropped.
- `chunk(N, fn)` walks every page (cursor-paginated). `fn` returning `false` stops cleanly; throws propagate.
- **V1 boundaries**: cursor pagination throws if `.cte()` / `.union()` are set. Multi-column sort keys not supported (use offset). See [`guides/relationships.md`](./guides/relationships.md#cursor-pagination---cursorpaginate-perpage-after-before).

### CTEs + UNION

```ts
.cte(name: string, body: QueryBuilder | { sql, params }): QueryBuilder<TModel>
.cteRecursive(name: string, body: QueryBuilder | { sql, params }): QueryBuilder<TModel>
.from(tableOrCte: string): QueryBuilder<TModel>
.union(other: QueryBuilder | { sql, params }): QueryBuilder<TModel>
.unionAll(other: QueryBuilder | { sql, params }): QueryBuilder<TModel>
```

- `.cte(name, body)` / `.cteRecursive(name, body)` prepend a `WITH [RECURSIVE] name AS (...)` clause. Multiple `.cte()` calls compose into one comma-separated WITH list; `RECURSIVE` emits at the WITH-clause level if any one CTE is recursive.
- `.from(name)` overrides the FROM clause — use after `.cte()` to read from the CTE. SELECT columns still come from the bound schema; the CTE body must return matching column shapes for `.get()` hydration.
- `.union(other)` / `.unionAll(other)` append `UNION [ALL] (other)` to the main SELECT. Each branch is parenthesized.
- All sub-bodies (typed `QueryBuilder` OR raw `{ sql, params }`) compile into the same params accumulator — `$N` placeholders renumber automatically.
- **V1 boundaries**: outer `ORDER BY` / `LIMIT` on a union is not supported (modifiers apply to the left branch); `count()` / `exists()` / `pluck()` / `paginate()` ignore the WITH clause and unions. See [`guides/ctes_and_unions.md`](./guides/ctes_and_unions.md).

## SQL emitter

Lower-level helpers the Repository + QueryBuilder compose. Exposed publicly for apps that need raw SQL emission with the same conventions (ULID auto-gen, identifier quoting, parameter binding, RETURNING).

```ts
function quoteIdent(name: string): string
function selectColumnList(schema: Schema): string
function emitInsert(schema, attrs): { sql, params }
function emitUpdateById(schema, id, changes): { sql, params }   // throws on empty changes
function emitDeleteById(schema, id): { sql, params }
function emitSoftDeleteById(schema, id): { sql, params }        // UPDATE … SET deleted_at = now()
function emitRestoreById(schema, id): { sql, params }           // UPDATE … SET deleted_at = NULL
function emitFindById(schema, id): { sql, params }
function emitFindMany(schema, ids): { sql, params }
function hasField(schema, name, kind?): boolean
function schemaHasSoftDelete(schema: Schema): boolean
```

`emitInsert` mints a fresh ULID/UUID when the schema declares an `id` field and the caller didn't supply one. `emitUpdateById` auto-appends `updated_at = now()` when the schema declared `t.timestamps()` and the caller didn't supply a value — and throws when there's nothing to update (an "update" with no caller-supplied changes is a programmer error).

## DDL emitters

Schema → Postgres DDL. Used by migrations to keep the SQL in lock-step with the schema definition; also the foundation the schema-diff migration generator will land on.

```ts
interface EmittedDdl { sql: string }

interface EmitOptions {
  registry?: SchemaRegistry     // required when the schema has reference fields
  ifExists?: boolean             // adds IF NOT EXISTS / IF EXISTS
}

function emitCreateTable(schema: Schema, opts?: EmitOptions): EmittedDdl
function emitDropTable(name: string, opts?: { ifExists?: boolean }): EmittedDdl
function emitAddColumn(schema: Schema, fieldName: string, opts?: EmitOptions): EmittedDdl
function emitDropColumn(table: string, column: string, opts?: { ifExists?: boolean }): EmittedDdl
function emitRenameTable(from: string, to: string): EmittedDdl
function emitRenameColumn(table: string, from: string, to: string): EmittedDdl

interface CreateIndexOptions {
  name?: string             // default `<table>_<col1>[_<col2>]…_idx`
  unique?: boolean
  where?: string            // partial-index predicate, e.g. `"deleted_at" IS NULL`
  using?: string            // `btree` (default) / `gin` / `gist` / `hash` / `brin`
  ifExists?: boolean        // adds IF NOT EXISTS
}
function emitCreateIndex(
  table: string,
  columns: readonly string[],
  opts?: CreateIndexOptions,
): EmittedDdl
function emitDropIndex(name: string, opts?: { ifExists?: boolean }): EmittedDdl

// Building blocks — exposed for the eventual migration generator + bespoke shapes:
function sqlTypeFor(field: SchemaField, registry?: SchemaRegistry): string
function columnDefinition(field: SchemaField, registry?: SchemaRegistry): string
function defaultSql(value: unknown): string
function findPrimaryKey(schema: Schema): SchemaField
function isPrimaryKeyKind(field: SchemaField): boolean
```

### Field-kind → Postgres type

| Kind | SQL type | Notes |
|---|---|---|
| `id` | `char(26)` | ULID — exactly 26 Crockford base32 chars. Inline `PRIMARY KEY`. |
| `uuid` | `uuid` | Inline `PRIMARY KEY`. |
| `bigSerial` | `bigserial` | Inline `PRIMARY KEY`. Postgres auto-creates the sequence. |
| `tenantedBigSerial` | `bigint NOT NULL DEFAULT 0` | On `tenanted: true` schemas: composite `PRIMARY KEY (tenant_id, id)` + `BEFORE INSERT` trigger calling `_strav_next_tenant_id(table, tenant_id)`. On non-tenanted schemas: just the plain column (no trigger / composite PK). |
| `string` | `varchar(N)` | `N` = `.max` (default 255). |
| `text` | `text` | |
| `integer` | `integer` | |
| `boolean` | `boolean` | |
| `decimal(p, s)` | `numeric(p, s)` | |
| `json` | `jsonb` | Always jsonb — indexable, faster on read. |
| `timestamp` | `timestamptz` / `timestamp` | `timestamptz` by default; `t.timestamp(..., { withTimezone: false })` gets `timestamp`. |
| `enum` | `text` + `CHECK` | Postgres ENUM types are painful to alter; text + CHECK is editable in place. |
| `reference` | _target PK type_ | Resolves through the registry — `t.reference('user_id').to(User)` adopts `User`'s PK type. |
| `encrypted` | `bytea` | Ciphertext + nonce + tag are bytes. |

### Column-definition layout

`<name> <type> [PRIMARY KEY] [NOT NULL] [UNIQUE] [DEFAULT …] [REFERENCES …] [CHECK …]`

`PRIMARY KEY` implies `NOT NULL` + `UNIQUE` in Postgres, so the emitter doesn't restate them on PK columns. Constraints are inlined per-column (no table-level `CONSTRAINT` declarations) — the emitter trades the slightly noisier per-column output for source-of-truth proximity.

### Defaults

`defaultSql(value)` serializes a default into inline SQL:

| Value | Emitted |
|---|---|
| `{ sql: 'now()' }` | `now()` — the framework-wide raw-SQL marker (used by `t.timestamps()`). |
| `'literal'` | `'literal'` (single-quoted, embedded quotes doubled) |
| `42` / `true` / `1n` | inline literal |
| `{ ... }` / `[ ... ]` | `'<json>'::jsonb` |
| `null` | `NULL` |

### References

`t.reference('user_id').to(User).onDelete('cascade')` requires a `SchemaRegistry` in `EmitOptions` so the FK column type can match the target PK. The emitter throws — loud-fail at migration time — if the registry is missing or doesn't contain the target schema.

The target PK column name is read from the target schema (`User.fields[0].name`), so `t.id('code')` on the target produces `REFERENCES "country" ("code")` rather than a guessed `("id")`.

### What's NOT here

Each lands in a follow-up cut:

- **`ALTER COLUMN` type changes** — type changes need backfill semantics; `emitRenameColumn` handles the simpler rename case.
- **Standalone `ADD FOREIGN KEY` / `DROP FOREIGN KEY`** — references inline into `CREATE TABLE` / `ADD COLUMN` already.
- **Migration builder DSL fluent surface** — `m.createTable(name, fn).addIndex(...)` chains. Today's emitters (`emitCreateTable`, `emitCreateIndex`, …) are called directly from migration files.
- **Destructive diff** — see "Migration generator" below; V1 detects only additive changes (new tables, new columns). Dropped tables/columns and type changes need explicit `--allow-drop` semantics + backfill design.

## Migration generator

Produces an additive migration from registered Schemas vs the live DB.

```ts
function inspectDatabase(db: DatabaseExecutor): Promise<DbSnapshot>

interface DiffOptions {
  allowDrop?: boolean           // emit drop-table / drop-column ops (default false)
  renames?: DiffRenames         // convert add+drop pairs into rename ops
}

interface DiffRenames {
  tables?: Record<oldName, newName>
  columns?: Record<schemaName, Record<oldColumn, newColumn>>   // schemaName = post-rename
}

function diffSchemas(
  registry: SchemaRegistry,
  snapshot: DbSnapshot,
  options?: DiffOptions,
): DiffResult

function generateMigration(opts: DiffOptions & {
  registry: SchemaRegistry
  db: DatabaseExecutor
  name?: string                 // default YYYYMMDDHHMMSS_auto_diff (UTC)
  now?: Date                    // override for deterministic naming in tests
}): Promise<GeneratedMigration | null>   // null when DB matches registry

type DiffOperation =
  | { kind: 'create-table'; schemaName: string; schema: Schema; sql: string }
  | { kind: 'add-column'; schemaName: string; columnName: string; sql: string }
  | { kind: 'drop-table'; tableName: string; sql: string }
  | { kind: 'drop-column'; tableName: string; columnName: string; sql: string }
  | { kind: 'rename-table'; from: string; to: string; sql: string }
  | { kind: 'rename-column'; tableName: string; from: string; to: string; sql: string }

interface DiffResult {
  operations: DiffOperation[]
  unknownTables: string[]       // tables in DB the registry doesn't know about (always reported)
}

interface GeneratedMigration {
  migration: Migration          // hand to MigrationRunner.register()
  diff: DiffResult              // for preview / logging
}
```

### What gets detected

Additive (always on):
- **New tables** — schema in registry, no matching table in `information_schema` → `emitCreateTable(schema)` op.
- **New columns** — column on a schema, not in the existing table → `emitAddColumn(schema, column)` op.

Destructive (opt-in via `allowDrop: true`):
- **Dropped tables** — table in DB, no schema in registry → `drop-table` op.
- **Dropped columns** — column in DB on a known table, no field on the schema → `drop-column` op.

Renames (opt-in via `renames: { tables, columns }`):
- **Renamed tables** — caller declares `{ tables: { oldName: newName } }`. The mapping consumes the would-be drop+create pair and emits a `rename-table` op.
- **Renamed columns** — caller declares `{ columns: { schemaName: { oldColumn: newColumn } } }` (keyed by the SCHEMA name, i.e., post-table-rename). Consumes the would-be add+drop pair.

### Ordering

1. `rename-table` ops first — table identity is set before anything else references it.
2. `rename-column` ops — column identity becomes correct.
3. `create-table` ops, topologically sorted by FK references.
4. `add-column` ops.
5. `drop-column` ops (only when `allowDrop`).
6. `drop-table` ops LAST, reverse-alphabetical (only when `allowDrop`).

### Cycles

A circular FK between two MISSING tables (each references the other) can't be created in one `CREATE TABLE` order. `diffSchemas` throws — apps break the cycle by making one reference nullable + adding it via a follow-up migration, or land the two tables in separate migrations.

### What still gets ignored

- **Type / nullability / default changes** on existing columns — needs ALTER COLUMN semantics with backfill design.
- **Indexes / constraints** — schemas don't declare them today (apart from inline UNIQUE / NOT NULL / CHECK / REFERENCES).

### `down()` is best-effort

Generated migration's `down()` reverses the ops in reverse order:

- `add-column` → `DROP COLUMN IF EXISTS`
- `create-table` → `DROP TABLE IF EXISTS`
- `rename-table` / `rename-column` → reverse-rename
- `drop-table` / `drop-column` → **NO-OP** (the diff discarded the original schema definition; apps that need to undo a drop recreate the entity by hand)

This is a safe-for-rollback inverse, not a "restore data" path. Apps with rollback-critical migrations should write them by hand.

## Multi-tenancy

Schemas marked `tenanted: true` opt into Postgres row-level-security tenant isolation. Two pieces:

1. **DDL emission** — `emitCreateTable` for a tenanted schema injects a `<tenant_registry>_id` FK column right after the PK and appends `ENABLE ROW LEVEL SECURITY` + a `CREATE POLICY` statement.
2. **Runtime scoping** — `TenantManager.withTenant(id, fn)` opens a transaction, sets `app.tenant_id` via `set_config(..., true)`, runs `fn(tx)`. RLS policies see the bound tenant and scope all reads + writes accordingly.

### Setup

Mark one schema as the tenant registry; mark each tenanted schema:

```ts
const tenantSchema = defineSchema('tenant', Archetype.Entity, (t) => {
  t.id()
  t.string('name')
  t.timestamps()
}, { tenantRegistry: true })

const postSchema = defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.string('title')
  t.timestamps()
}, { tenanted: true })
```

`tenantRegistry` and `tenanted` are mutually exclusive (the registry table itself isn't tenant-scoped). Apps register both with `SchemaRegistry` before emitting migrations.

### What CREATE TABLE emits for a tenanted schema

```sql
CREATE TABLE "post" (
  "id" char(26) PRIMARY KEY,
  "tenant_id" char(26) NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE,
  "title" varchar(255) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "post_tenant_isolation" ON "post"
  USING ("tenant_id" = current_setting('app.tenant_id')::char(26))
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::char(26))
```

The cast target matches the tenant registry's PK type — `uuid`, `bigint`, or `char(26)`. `bigserial` PKs normalize to `bigint` for the cast (bigserial is a pseudo-type).

The tenant FK column is placed right after the PK so reading the schema in psql tells you "what's this row's tenant?" at a glance.

### `TenantManager`

```ts
class TenantManager {
  constructor(db: Database)

  withTenant<T>(tenantId: string, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>
  withoutTenant<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>
  withTenantLock<T>(
    tenantId: string,
    lockKey: string,
    fn: (tx: DatabaseExecutor) => Promise<T>,
  ): Promise<T>
  withLock<T>(lockKey: string, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>
  currentTenantId(): string | null
}
```

- **`withTenant(id, fn)`** — opens a transaction, runs `SELECT set_config('app.tenant_id', $1, true)`, then `fn(tx)`. Transaction-local binding auto-clears on COMMIT / ROLLBACK.
- **`withoutTenant(fn)`** — opens a transaction without binding the tenant. Intended for admin / migration paths; requires the underlying connection to be a `BYPASSRLS` Postgres role to actually see across tenants.
- **`withTenantLock(id, lockKey, fn)`** — `withTenant(id, ...)` plus `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`. Holds a transaction-level advisory lock keyed by the `(tenantId, lockKey)` pair — different tenants holding the same key don't contend. Auto-releases at COMMIT / ROLLBACK. Inside an existing `withTenant(id, …)` scope, the lock is acquired on the existing transaction (no nested tx).
- **`withLock(lockKey, fn)`** — non-tenanted variant: `withoutTenant(...)` plus `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`. For fleet-wide singletons (cron jobs, leadership fences, one-time migrations). Needs the BYPASSRLS connection if touching RLS-protected tables.
- **`currentTenantId()`** — the active tenant inside any `withTenant` scope, `null` outside. Propagates through nested async via AsyncLocalStorage.
- **Nesting** — `withTenant('A', () => withTenant('A', ...))` is fine (same tenant). `withTenant('A', () => withTenant('B', ...))` throws; tenant switches must be explicit (exit the outer scope first). Same rule applies to `withTenantLock` — same tenant reuses the outer tx + adds the lock; different tenant throws.
- **Exception safety** — if `fn` throws, the transaction rolls back, the ALS scope unwinds, `currentTenantId()` returns to its prior value, and any advisory locks held by the transaction release.

### Helpers (low-level)

```ts
function tenantRegistrySchema(registry: SchemaRegistry | undefined): Schema  // throws if missing
function tenantIdColumnName(tenantReg: Schema): string                        // e.g. 'tenant_id'
function emitRlsForTenanted(schema: Schema, registry: SchemaRegistry): string // multi-statement
```

Use these directly when writing a custom migration that needs the RLS plumbing without going through `emitCreateTable` (e.g., bringing an existing table into tenancy).

### Production helpers

```ts
function validateTenantRegistry(db: DatabaseExecutor, registry: SchemaRegistry): Promise<void>
function emitTenantIdFunction(registry: SchemaRegistry | undefined): EmittedDdl
```

`validateTenantRegistry` checks the live DB at app boot: (1) registry schema is declared if any tenanted schemas are; (2) the registry table exists; (3) its PK column type matches what the schema declared. Throws `ConfigError` with specific messages. No-op when no tenanted schemas are registered. Opt-in — apps call it from their start path.

`emitTenantIdFunction` returns the DDL for a Postgres `STABLE` function:

```sql
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS <pk_type> AS $$
  SELECT current_setting('app.tenant_id', true)::<pk_type>
$$ LANGUAGE sql STABLE
```

Apps include it in their initial tenancy migration. After that, raw-SQL paths can use `current_tenant_id()` instead of the inline `current_setting(...)::<type>` cast. Returns NULL outside `withTenant` (same defensive failure as RLS policies).

### What's NOT here

Each is its own follow-up tenancy slice:

- **Boot-time tenant-registry validation.** The provider doesn't yet check that the tenant registry table exists in the live DB with the expected PK type. Misconfiguration surfaces as a Postgres error at first query.
- **Schema-diff awareness.** `generateMigration` doesn't detect "this existing table is missing its tenant_id column / RLS policy." Apps adding tenancy to an existing table write the migration explicitly.
## Unit of work

`UnitOfWork.run(fn)` wraps a callback in one transaction + tx-routing for Repository calls + queue-until-commit for lifecycle post-events.

```ts
class UnitOfWork {
  constructor(db: Database, events: EventBus | undefined)

  run<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T>
}
```

- **One transaction per `run`.** `Database.transaction` underneath; commit on `fn` return, rollback on throw.
- **AsyncLocalStorage propagation.** Repository CRUD methods called inside `fn` auto-route to `tx` — apps don't have to thread `tx` through every function call.
- **Queue-until-commit post-events.** `.created` / `.updated` / `.deleted` queue in the transactional context, flush after `fn` returns but before COMMIT. If `fn` throws, the queue drops.
- **Cancelable `<verb>ing` events fire immediately**, before each Repository SQL — queueing would defeat their abort-via-throw semantic.
- **Nested `run` reuses the outer scope** — one transaction, one queue, no savepoint. Apps that want savepoints reach for `tx.execute('SAVEPOINT …')` directly.

`TenantManager.withTenant(id, fn)` and `withoutTenant(fn)` use `UnitOfWork.run` internally; the same auto-routing + queue-until-commit applies.

See [`guides/unit_of_work.md`](./guides/unit_of_work.md) for the full transactional flow, cancelable-vs-post-event semantics, and when to reach for `Database.transaction` directly instead.
