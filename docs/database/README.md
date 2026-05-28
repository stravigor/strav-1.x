# @strav/database

Postgres connection pool, schema DSL, migration runner, Model + Repository + QueryBuilder for Strav 1.0. Built on **Bun.SQL** (Bun's built-in Postgres driver) — no native modules.

> **Status: 1.0.0-alpha — M2 in progress.** Foundation + ORM + DDL + diff (additive + destructive) + tenancy + lifecycle events + unit-of-work + soft-delete + relations + decorators (`@hidden` / `@cast` / `@ulid` / `@encrypt`) + advisory locks + boot-time tenant-registry validation all shipped.
> Shipping: **PostgresDatabase** + **AdminDatabase** (connection pools, query/queryOne/execute/transaction), **DatabaseProvider** (config-driven lifecycle, lazy or eager connect, opt-in BYPASSRLS admin pool via `config.database.admin`), **defineSchema** + **Archetype** + **t.* builders** (including `t.softDeletes()`, `t.hasMany()`, `t.belongsTo()`, `t.encrypted()`), **SchemaRegistry**, **MigrationRunner** (migrate/rollback/status, `_strav_migrations` tracking, per-migration transactions, batch grouping), **Model** (`@hidden`/`@cast`/`@ulid`/`@encrypt`), **Repository<T>** (find/findOrFail/findMany/first/all/create/update/delete/restore/forceDelete/exists/count + `.query()` + **lifecycle events** `<resource>.{creating,created,updating,updated,deleting,deleted,restoring,restored}` with cancelable pre-verbs + queue-until-commit post-verbs), **QueryBuilder** (where/orderBy/limit/offset/select + `.with(...)` eager loading + soft-delete scopes + offset `.paginate({ page, perPage })` + `.cursorPaginate({ perPage, after?, before? })` + `.chunk(perPage, fn)` + `.cte` / `.cteRecursive` + `.union` / `.unionAll` + `.from(cte_name)` + get/first/firstOrFail/count/exists/pluck; immutable chains), **SQL emitter** (auto-ULID, auto-`updated_at`, RETURNING), **DDL emitters** (`emitCreateTable` / `emitDropTable` / `emitAddColumn` / `emitDropColumn` / `emitCreateIndex` / `emitDropIndex` / `emitRenameTable` / `emitRenameColumn`), **schema-diff generator** (`inspectDatabase` reads `information_schema`; `diffSchemas` produces additive + opt-in destructive ops in topological FK order; `generateMigration` wraps into a ready-to-register `Migration` with `allowDrop` + `renames`), **multi-tenancy** (`tenanted: true` schemas auto-inject the `<registry>_id` FK + emit RLS policies; `t.tenantedBigSerial()` adds per-tenant sequencing — trigger + composite `(tenant_id, id)` PK + shared `_strav_tenant_sequences` counter; **TenantManager** runs callbacks inside `set_config('app.tenant_id', …, true)` transactions via AsyncLocalStorage, with `withTenant` / `withoutTenant` / `withTenantLock` / `withLock` variants), **UnitOfWork.run** (one transaction + ALS tx-routing + queue-until-commit), **validateTenantRegistry** (boot-time live-DB check) + **emitTenantIdFunction** (Postgres `STABLE current_tenant_id()`), **EncryptionProvider** + **AesGcm256Cipher** (AES-256-GCM, 12-byte random IV, 128-bit auth tag, `iv||tag||ct` layout).
> Deferred (each is its own slice): **explicit `.join()` / `.leftJoin()`** (`.with(...)` covers the N+1 case via batched SELECTs today), **`generateMigration` type-change detection** (USING-clause + backfill strategies), **migration builder DSL** (`m.createTable(name, fn)` / `m.addIndex(...)` etc.), **tenancy diff awareness** (the diff generator doesn't auto-add tenant_id/RLS to existing tenanted tables), **`db:migrate` / `db:rollback` / `db:status` / `make:migration` console commands** (need `@strav/cli`), **encryption key rotation + blind-index helpers + per-tenant keys + async Ciphers** (KMS/HSM), **typed Model children + nested eager loading + `hasOne` / `belongsToMany` + `whereHas` + lazy loading**, **cascading soft-delete on `t.reference(...)`**.

## Install

```bash
bun add @strav/database
```

Peer dep: `@strav/kernel` (already in the workspace). No native modules.

## Minimal app

```ts
// config/database.ts
export default {
  url: env.required('DATABASE_URL'),     // postgres://user:pass@host:5432/db
  idleTimeout: 30,                       // seconds
  max: 20,                               // pool size
  lazyConnect: true,                     // false = connect at boot, fail-fast
}
```

```ts
// bin/strav.ts
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'
import { DatabaseProvider } from '@strav/database'
import dbConfig from '../config/database.ts'
import loggerConfig from '../config/logger.ts'

const app = new Application().useProviders([
  new ConfigProvider({ logger: loggerConfig, database: dbConfig }),
  new LoggerProvider(),
  new DatabaseProvider(),
])

await app.start()
```

## Defining a schema

```ts
// database/schemas/user_schema.ts
import { Archetype, defineSchema } from '@strav/database'

export const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()                                 // ULID primary key
  t.string('email').max(320).unique()
  t.string('name')
  t.timestamp('email_verified_at').nullable()
  t.softDeletes()                        // adds deleted_at
  t.timestamps()                         // adds created_at, updated_at
})
```

## Writing a migration

Migrations are plain objects with `name` / `up(db)` / `down(db)`. The runner sorts by name alphabetically — adopt the `YYYYMMDDHHMMSS_short_description` convention so the order is also a timeline.

Use the DDL emitters to keep the SQL in lock-step with the schema:

```ts
// database/migrations/20260528000000_create_users.ts
import { emitCreateTable, emitDropTable, type Migration } from '@strav/database'
import { userSchema } from '../schemas/user_schema.ts'

export const migration: Migration = {
  name: '20260528000000_create_users',
  async up(db) {
    await db.execute(emitCreateTable(userSchema).sql)
  },
  async down(db) {
    await db.execute(emitDropTable(userSchema.name).sql)
  },
}
```

If the schema has reference fields, pass the registry so the FK columns adopt the right PK type:

```ts
async up(db) {
  await db.execute(emitCreateTable(postSchema, { registry: schemas }).sql)
}
```

Raw `db.execute('CREATE TABLE …')` still works — DDL emitters are a convenience, not a requirement.

Register migrations + run them:

```ts
import { MigrationRunner, PostgresDatabase } from '@strav/database'
import { migration as createUsers } from '../database/migrations/20260528000000_create_users.ts'

const runner = new MigrationRunner(app.resolve(PostgresDatabase))
  .register(createUsers)

const result = await runner.migrate()    // { applied: [...], batch: 1 }
const status = await runner.status()     // { applied, pending }
await runner.rollback()                  // rolls back the most recent batch
```

The console commands (`bun strav db:migrate` / `db:rollback` / `db:status`) land with `@strav/cli`'s db integration in a follow-up cut.

## What's here

| Symbol | Purpose |
|---|---|
| `Database` (interface) | The runtime contract — `query` / `queryOne` / `execute` / `transaction` / `close` / `raw` |
| `PostgresDatabase` | Concrete implementation backed by `Bun.SQL` — the app-role (NOBYPASSRLS) pool |
| `AdminDatabase` | Second `PostgresDatabase` pool for the BYPASSRLS role; opt-in via `config.database.admin`. `TenantManager.withoutTenant` / `withLock` route through it |
| `DatabaseExecutor` | The subset of `Database` available inside a transaction callback |
| `DatabaseProvider` | ServiceProvider wiring; binds `Database` from `config.database`, plus `AdminDatabase` when `config.database.admin` is set |
| `defineSchema(name, archetype, fn, opts?)` | The single source of truth for a table |
| `Archetype` enum | `Entity / Attribute / Reference / Event / Configuration` |
| `Schema` + `SchemaField` (+ per-kind subtypes) | The immutable shape `defineSchema` returns |
| `SchemaRegistry` | Runtime catalog of registered schemas. `register` / `registerAll` for explicit wiring; `await discover(pattern, { cwd? })` for `Bun.Glob`-based auto-discovery |
| `isSchema(value)` | Type-guard used by `discover()`; exported for hand-rolled discovery loops |
| `Migration` | `{ name, up(db), down(db) }` |
| `MigrationRunner` | `register` / `registerAll` / `migrate` / `rollback` / `status` / `list` |
| `Model` | Plain typed entity. `static schema = …`. `toJSON()` honors `@hidden`. |
| `@hidden` decorator | Marks a field as omitted from `toJSON()` / `JSON.stringify`. |
| `@cast` decorator | Bidirectional DB↔Model type coercion (`fromDb` on read, `toDb` on write). Useful for value objects, jsonb-as-string, custom enum types. |
| `@ulid` decorator | Auto-generate + validate ULID-shaped string columns. Auto-mints on `create` when unset; validates user-supplied values on both `create` and `update`. |
| `@encrypt` decorator | Encryption-at-rest. `Cipher.encrypt` runs after `@cast.toDb` on writes; `Cipher.decrypt` runs before `@cast.fromDb` on hydration. Defaults to AES-256-GCM via `EncryptionProvider`. |
| `Repository<TModel>` | Injectable data-access object — `find` / `create` / `update` / `delete` / `forceDelete` / `restore` / `query()` / `exists` / `count` |
| `QueryBuilder<TModel>` | Fluent SELECT — `where` / `orderBy` / `limit` / `offset` / `select` / `withTrashed` / `onlyTrashed` / `with` (eager loading) / `get` / `first` / `count` / `pluck` / `paginate` |
| `PaginatedResult<T>` | `{ data, total, page, perPage, totalPages }` returned by `query().paginate({ page, perPage })` |
| `emitInsert` / `emitUpdateById` / `emitDeleteById` / `emitFindById` / `emitFindMany` | SQL emitter helpers used by Repository — direct use for raw SQL emission with the same conventions |
| `emitCreateTable` / `emitDropTable` / `emitAddColumn` / `emitDropColumn` | DDL emitters — schema → Postgres SQL, used by migrations |
| `emitCreateIndex` / `emitDropIndex` / `emitRenameTable` / `emitRenameColumn` | DDL emitters for index ops + renames; complement the schema-driven helpers |
| `sqlTypeFor` / `columnDefinition` / `defaultSql` / `findPrimaryKey` / `isPrimaryKeyKind` | DDL building blocks; exposed for migration generators and bespoke shapes |
| `quoteIdent` / `selectColumnList` | Building blocks the emitter uses; exposed for raw-SQL escape hatches |
| `inspectDatabase` | Read live `information_schema` into a `DbSnapshot` |
| `diffSchemas` | Compare registry vs snapshot → `DiffResult` (additive ops + opt-in drops/renames + unknownTables) |
| `generateMigration` | One-call wrapper — returns a ready-to-register `Migration` or `null` if no changes; supports `allowDrop` + `renames` |
| `TenantManager` | `withTenant(id, fn)` / `withoutTenant(fn)` / `withTenantLock(id, key, fn)` / `withLock(key, fn)` — runs callbacks inside RLS-scoped transactions (built on UnitOfWork); the `*Lock` variants add `pg_advisory_xact_lock` for serialized concurrent work |
| `UnitOfWork` | `run(fn)` — one transaction + ALS-based tx-routing for Repository calls + queue-until-commit for post-events |
| `tenantRegistrySchema` / `tenantIdColumnName` / `emitRlsForTenanted` / `emitTenantedBigSerialSetup` | Tenancy DDL helpers — used by `emitCreateTable` for `tenanted: true` schemas, exposed for raw SQL paths |
| `validateTenantRegistry` / `emitTenantIdFunction` | Production tenancy helpers — boot-time live-DB validation + Postgres `current_tenant_id()` STABLE function |

## Documentation

- [`api.md`](./api.md) — every export with signature + semantics.
- [`guides/schemas.md`](./guides/schemas.md) — defining schemas, field types, modifiers, composites, tenancy flags, registry usage.
- [`guides/migrations.md`](./guides/migrations.md) — writing migrations, runner mechanics, batching + rollback semantics, transactional boundaries.
- [`guides/migration_generator.md`](./guides/migration_generator.md) — `generateMigration(registry, db)` end-to-end, what's detected, what's not, FK topological ordering, cycle handling.
- [`guides/multi_tenancy.md`](./guides/multi_tenancy.md) — `tenanted: true` schemas, the auto-injected tenant FK + RLS policy, `TenantManager.withTenant(...)`, two-role setup (today: manual; tomorrow: framework), what's deferred (composite PKs, diff awareness, repository routing).
- [`guides/unit_of_work.md`](./guides/unit_of_work.md) — `UnitOfWork.run(fn)`: one transaction, auto-routed Repository calls via AsyncLocalStorage, queue-until-commit semantics for post-events, nested behavior, when to use vs `Database.transaction`.
- [`guides/soft_delete.md`](./guides/soft_delete.md) — `t.softDeletes()` schemas: delete becomes UPDATE deleted_at, default scope excludes trashed rows, `withTrashed()` / `onlyTrashed()` / `restore()` / `forceDelete()`, lifecycle events with the `force` flag, tradeoffs.
- [`guides/relationships.md`](./guides/relationships.md) — `t.hasMany` / `t.belongsTo` declarations, `.with(...)` eager loading (one batched SELECT per relation, N+1 prevention), offset `.paginate({ page, perPage })` + cursor `.cursorPaginate({ perPage, after?, before? })` + `.chunk(perPage, fn)`, what's deferred (typed children, nested loads, lazy loading).
- [`guides/ctes_and_unions.md`](./guides/ctes_and_unions.md) — `.cte(name, body)` / `.cteRecursive(name, body)` / `.from(cte_name)` / `.union(other)` / `.unionAll(other)`, automatic placeholder renumbering across sub-bodies, V1 boundaries (outer modifiers on union, count/exists/pluck/paginate skip the WITH clause).
- [`guides/model_decorators.md`](./guides/model_decorators.md) — `@hidden` / `@cast` / `@ulid` / `@encrypt` decorators, `Model.toJSON()`, inheritance rules, custom `toJSON` overrides, runtime metadata inspection, key rotation / blind-index notes for `@encrypt`.
- [`guides/repositories.md`](./guides/repositories.md) — Model + Repository<T> + QueryBuilder; the three-layer split; what's automatic (ULID, updated_at, RETURNING) vs deferred (hooks, soft deletes, relationships, pagination); testing patterns.
