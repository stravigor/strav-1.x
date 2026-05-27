# @strav/database — API Reference

> **Status:** Reflects what's implemented as of M2 (database foundation slice) — Database wrapper, DatabaseProvider, Schema DSL, SchemaRegistry, MigrationRunner. Repository / Model / query builder / RLS / migration generator land in follow-up cuts.

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
