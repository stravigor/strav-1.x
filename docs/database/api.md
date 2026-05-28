# @strav/database — API Reference

> **Status:** Reflects what's implemented as of M2 (foundation + ORM + DDL + diff + tenancy + Repository hooks) — Database wrapper, DatabaseProvider, Schema DSL, SchemaRegistry, MigrationRunner, Model, Repository<T> (with lifecycle events), QueryBuilder, SQL emitter, DDL emitters, schema-diff generator, multi-tenancy (DDL + TenantManager). Decorators, soft-delete integration, relationships + eager loading, pagination, joins/CTEs, queue-until-commit semantics, migration builder DSL, destructive diff, `tenantedSerial` per-tenant sequencing, two-role connection config, Repository tx-routing inside `withTenant` all land in follow-up cuts.

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

### `boot()`

By default a no-op (`lazyConnect: true`). Pass `lazyConnect: false` in config to call `Bun.SQL.connect()` at boot, so misconfig / network failures surface immediately instead of on the first query.

### `shutdown()`

Calls `db.close({ timeout: config.database.shutdownTimeoutSeconds ?? 5 })`. Wrapped in try/catch — never throws past the kernel boundary.

### Config slice

```ts
interface DatabaseConfigShape {
  url: string                          // postgres://user:pass@host:5432/db
  idleTimeout?: number                 // seconds; Bun.SQL default
  max?: number                         // pool size; Bun.SQL default
  lazyConnect?: boolean                // default true
  shutdownTimeoutSeconds?: number      // default 5
}
```

Missing `url` throws `ConfigError` at the first `app.resolve(PostgresDatabase)` call (which is `boot()` itself when `lazyConnect: false`; first request when lazy).

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
| `'tenantedSerial'` | (per-tenant sequence) |
| `'string'` | `max: number` (default 255) |
| `'text'` | — |
| `'integer'` | — |
| `'boolean'` | — |
| `'decimal'` | `precision: number`, `scale: number` |
| `'json'` | — |
| `'timestamp'` | `withTimezone: boolean` (default true) |
| `'enum'` | `values: readonly string[]` |
| `'reference'` | `references: string` (target table name), `onDelete: 'cascade' \| 'set null' \| 'restrict' \| 'no action'` |
| `'encrypted'` | (encrypted at rest via the encryption subsystem — encryption integration lands later) |

Every field also has `nullable: boolean`, `unique: boolean`, `hasDefault: boolean`, `default: unknown`, `order: number`.

## `SchemaBuilder` (the `t` argument)

Identity:

```ts
t.id()                                   // ULID, name 'id'
t.uuid()                                 // UUID variant
t.bigSerial()                            // auto-increment bigint
t.tenantedSerial()                       // per-tenant sequence
```

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
  get(name: string): Schema | undefined
  getOrFail(name: string): Schema       // throws ConfigError on miss
  has(name: string): boolean
  all(): readonly Schema[]
  clear(): void                          // test helper
}
```

Apps register schemas in a provider (typically `SchemasProvider`, depends on `'database'`). `register` throws `ConfigError` on duplicate name.

Auto-discovery of `database/schemas/**.ts` via `Bun.Glob` lands when the convention is fully baked in `@strav/cli`'s generator. The manual API is the source of truth for now.

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
}

interface ModelClass<T extends Model = Model> {
  schema: Schema
  new (): T
}

function hydrateRow<T extends object>(schema: Schema, row, target: T): T
function isModelClass(value: unknown): value is ModelClass
```

Subclasses declare `static schema = userSchema` and add typed fields. `hydrateRow` copies schema-declared columns from a DB row onto a fresh instance; the `Repository` calls it internally on every find/create/update.

Decorators (`@encrypt` / `@hidden` / `@cast` / `@ulid`) land with the encryption + serialization slice. For now, the Model is a pure data holder.

## `Repository<TModel>`

Injectable data-access object. Subclasses declare `static schema = …` and `static model = …`; the base resolves them at construction.

```ts
abstract class Repository<TModel> {
  static readonly schema: Schema
  static readonly model: ModelClass

  constructor(db: PostgresDatabase, events?: EventBus)

  find(id): Promise<TModel | null>
  findOrFail(id): Promise<TModel>             // throws NotFoundError
  findMany(ids): Promise<TModel[]>             // empty list short-circuits
  first(): Promise<TModel | null>
  all(): Promise<TModel[]>

  create(attrs: Partial<TModel>): Promise<TModel>
  update(model: TModel, changes: Partial<TModel>): Promise<TModel>
  delete(model: TModel): Promise<void>

  query(): QueryBuilder<TModel>

  exists(where: Partial<TModel>): Promise<boolean>
  count(where?: Partial<TModel>): Promise<number>
}
```

`@inject()`-marked subclasses get both `PostgresDatabase` and `EventBus` resolved via the container — the kernel's `Application` registers `EventBus` as a singleton in its constructor. Subclasses that don't list `EventBus` in their constructor (or test code that passes only the db) get an `events`-less repository — `create` / `update` / `delete` still work, they just don't emit lifecycle events.

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
| `<resource>.deleting` | ✓ | `{ resource, model }` |
| `<resource>.deleted` | — | `{ resource, model }` |

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

**Queue-until-commit semantics is deferred.** Today, `.created` listeners run as soon as the INSERT succeeds — if the surrounding (non-existent yet) transaction would later roll back, side effects already fired. Apps that need transactional event handling should hold off on side effects in `.created` until the unit-of-work slice lands with `tx?` parameter routing.

### What's NOT automatic

See [`guides/repositories.md`](./guides/repositories.md) — soft-delete integration, relationships + eager loading, pagination, queue-until-commit semantics, and the `tx?` parameter all land in follow-up slices.

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

  toSql(): { sql: string; params: unknown[] }

  get(): Promise<TModel[]>
  first(): Promise<TModel | null>             // implicit LIMIT 1
  firstOrFail(): Promise<TModel>
  count(): Promise<number>                     // SELECT COUNT(*) — ignores LIMIT
  exists(): Promise<boolean>                   // SELECT 1 ... LIMIT 1
  pluck<T>(column: string): Promise<T[]>
}

type WhereOperator =
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'like' | 'ilike'
  | 'in' | 'not in'
  | 'is null' | 'is not null'
```

Empty `whereIn`/`whereNotIn` arrays emit `FALSE`/`TRUE` so the query stays valid SQL.

## SQL emitter

Lower-level helpers the Repository + QueryBuilder compose. Exposed publicly for apps that need raw SQL emission with the same conventions (ULID auto-gen, identifier quoting, parameter binding, RETURNING).

```ts
function quoteIdent(name: string): string
function selectColumnList(schema: Schema): string
function emitInsert(schema, attrs): { sql, params }
function emitUpdateById(schema, id, changes): { sql, params }   // throws on empty changes
function emitDeleteById(schema, id): { sql, params }
function emitFindById(schema, id): { sql, params }
function emitFindMany(schema, ids): { sql, params }
function hasField(schema, name, kind?): boolean
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
| `tenantedSerial` | `bigint` | Inline `PRIMARY KEY`. Per-tenant sequencing (trigger + sequence + RLS) lands with the tenancy slice. |
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

- **`RENAME TABLE` / `RENAME COLUMN` / `CHANGE COLUMN`** — renames need migration-time identity tracking; type changes need backfill semantics.
- **`ADD INDEX` / `DROP INDEX`** — indexes aren't part of the Schema; explicit index ops belong to the migration builder DSL.
- **Standalone `ADD FOREIGN KEY` / `DROP FOREIGN KEY`** — references inline into `CREATE TABLE` / `ADD COLUMN` already.
- **Tenancy plumbing** — RLS policies, tenant-FK column injection on `tenanted: true` schemas, the composite `(tenant_id, id)` PK. The current emitter ignores `tenancy.tenanted`; the tenancy slice wraps the DDL with those policies.
- **Destructive diff** — see "Migration generator" below; V1 detects only additive changes (new tables, new columns). Dropped tables/columns and type changes need explicit `--allow-drop` semantics + backfill design.

## Migration generator

Produces an additive migration from registered Schemas vs the live DB.

```ts
function inspectDatabase(db: DatabaseExecutor): Promise<DbSnapshot>

function diffSchemas(registry: SchemaRegistry, snapshot: DbSnapshot): DiffResult

function generateMigration(opts: {
  registry: SchemaRegistry
  db: DatabaseExecutor
  name?: string                 // default YYYYMMDDHHMMSS_auto_diff (UTC)
  now?: Date                    // override for deterministic naming in tests
}): Promise<GeneratedMigration | null>   // null when DB matches registry

type DiffOperation =
  | { kind: 'create-table'; schemaName: string; schema: Schema; sql: string }
  | { kind: 'add-column'; schemaName: string; columnName: string; sql: string }

interface DiffResult {
  operations: DiffOperation[]
  unknownTables: string[]       // tables in DB the registry doesn't know about
}

interface GeneratedMigration {
  migration: Migration          // hand to MigrationRunner.register()
  diff: DiffResult              // for preview / logging
}
```

### What gets detected

- **New tables** — schema in registry, no matching table in `information_schema` → `emitCreateTable(schema)` op.
- **New columns** — column on a schema, not in the existing table → `emitAddColumn(schema, column)` op.

### Ordering

1. All `create-table` ops first, **topologically sorted** by FK references. A table referencing another comes after its target. References to tables already in the DB impose no ordering constraint (the target exists).
2. All `add-column` ops, after all `create-table` ops. So a new column with `REFERENCES` resolves cleanly.

### Cycles

A circular FK between two MISSING tables (each references the other) can't be created in one `CREATE TABLE` order. `diffSchemas` throws — apps break the cycle by making one reference nullable + adding it via a follow-up migration, or land the two tables in separate migrations.

### What gets ignored

Each lands as its own slice:

- **Dropped tables** — surfaced in `result.unknownTables` (informational); never auto-dropped. Apps that need to drop write the migration by hand or wait for the `--allow-drop` slice.
- **Dropped columns** — same reasoning.
- **Type / nullability / default changes** on existing columns — needs ALTER COLUMN semantics with backfill design.
- **Renames** — undetectable from diff alone; needs explicit `rename: { from, to }` mapping support.
- **Indexes / constraints** — schemas don't declare them today (apart from inline UNIQUE / NOT NULL / CHECK / REFERENCES).

### `down()` is best-effort

Generated migration's `down()` reverses the ops: `DROP COLUMN IF EXISTS` for added columns; `DROP TABLE IF EXISTS` for created tables, in reverse op order. This is a safe-for-rollback inverse, not a "restore data" path — apps with rollback-critical migrations should write them by hand.

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
  currentTenantId(): string | null
}
```

- **`withTenant(id, fn)`** — opens a transaction, runs `SELECT set_config('app.tenant_id', $1, true)`, then `fn(tx)`. Transaction-local binding auto-clears on COMMIT / ROLLBACK.
- **`withoutTenant(fn)`** — opens a transaction without binding the tenant. Intended for admin / migration paths; requires the underlying connection to be a `BYPASSRLS` Postgres role to actually see across tenants.
- **`currentTenantId()`** — the active tenant inside any `withTenant` scope, `null` outside. Propagates through nested async via AsyncLocalStorage.
- **Nesting** — `withTenant('A', () => withTenant('A', ...))` is fine (same tenant). `withTenant('A', () => withTenant('B', ...))` throws; tenant switches must be explicit (exit the outer scope first).
- **Exception safety** — if `fn` throws, the transaction rolls back, the ALS scope unwinds, `currentTenantId()` returns to its prior value.

### Helpers (low-level)

```ts
function tenantRegistrySchema(registry: SchemaRegistry | undefined): Schema  // throws if missing
function tenantIdColumnName(tenantReg: Schema): string                        // e.g. 'tenant_id'
function emitRlsForTenanted(schema: Schema, registry: SchemaRegistry): string // multi-statement
```

Use these directly when writing a custom migration that needs the RLS plumbing without going through `emitCreateTable` (e.g., bringing an existing table into tenancy).

### What's NOT here

Each is its own follow-up tenancy slice:

- **Composite `(tenant_id, id)` PK for `t.tenantedSerial()`.** Today's tenanted schemas should use `t.id()` (ULID) — globally unique by construction, so the tenant FK is just a scoping column.
- **Two-role connection config.** Apps need a `NOBYPASSRLS` Postgres role for runtime + a `BYPASSRLS` role for migrations / admin. Today: wire two `DatabaseProvider`s with different config slices. Framework-managed dual roles land later.
- **Boot-time tenant-registry validation.** The provider doesn't yet check that the tenant registry table exists in the live DB with the expected PK type. Misconfiguration surfaces as a Postgres error at first query.
- **Schema-diff awareness.** `generateMigration` doesn't detect "this existing table is missing its tenant_id column / RLS policy." Apps adding tenancy to an existing table write the migration explicitly.
- **Repository<TModel> auto-routing inside `withTenant`.** Today, `repo.find(id)` outside `tx` doesn't see the tenant binding. Pass `tx` explicitly via the deferred `tx?` parameter (`repo.find(id, { tx })`) — or call `tx.query(...)` directly. Auto-routing lands with the unit-of-work slice.
