# @strav/database

Postgres connection pool, schema DSL, migration runner, Model + Repository + QueryBuilder for Strav 1.0. Built on **Bun.SQL** (Bun's built-in Postgres driver) — no native modules.

> **Status: 1.0.0-alpha — M2 in progress (foundation + ORM slice).**
> Shipping: **PostgresDatabase** (connection pool, query/queryOne/execute/transaction), **DatabaseProvider** (config-driven lifecycle, lazy or eager connect), **defineSchema** + **Archetype** + **t.* builders**, **SchemaRegistry**, **MigrationRunner** (migrate/rollback/status, `_strav_migrations` tracking, per-migration transactions, batch grouping), **Model** (minimal — schema link + hydration), **Repository<T>** (find/findOrFail/findMany/first/all/create/update/delete/exists/count + .query()), **QueryBuilder** (where/orderBy/limit/offset/select + get/first/firstOrFail/count/exists/pluck; immutable chains), **SQL emitter** (auto-ULID, auto-`updated_at`, RETURNING).
> Deferred (each is its own slice): **decorators** (`@encrypt` / `@hidden` / `@cast` / `@ulid`), **repository lifecycle hooks** (`<resource>.creating` / `.created` / etc. on the EventBus), **soft-delete integration** (`.withTrashed()`, `delete()` writing `deleted_at`), **relationships + eager loading**, **pagination helpers**, **joins + CTEs**, schema-diff → SQL **migration generator**, **multi-tenancy / RLS emission**, the **`db:migrate` / `db:rollback` / `db:status` console commands** (need `@strav/cli` integration).

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

```ts
// database/migrations/20260528000000_create_users.ts
import type { Migration } from '@strav/database'

export const migration: Migration = {
  name: '20260528000000_create_users',
  async up(db) {
    await db.execute(`
      CREATE TABLE "user" (
        id          char(26)    PRIMARY KEY,
        email       varchar(320) NOT NULL UNIQUE,
        name        varchar(255) NOT NULL,
        deleted_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `)
  },
  async down(db) {
    await db.execute(`DROP TABLE "user"`)
  },
}
```

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
| `PostgresDatabase` | Concrete implementation backed by `Bun.SQL` |
| `DatabaseExecutor` | The subset of `Database` available inside a transaction callback |
| `DatabaseProvider` | ServiceProvider wiring; binds `Database` from `config.database` |
| `defineSchema(name, archetype, fn, opts?)` | The single source of truth for a table |
| `Archetype` enum | `Entity / Attribute / Reference / Event / Configuration` |
| `Schema` + `SchemaField` (+ per-kind subtypes) | The immutable shape `defineSchema` returns |
| `SchemaRegistry` | Runtime catalog of registered schemas |
| `Migration` | `{ name, up(db), down(db) }` |
| `MigrationRunner` | `register` / `registerAll` / `migrate` / `rollback` / `status` / `list` |
| `Model` | Plain typed entity. `static schema = …`. Decorators land later. |
| `Repository<TModel>` | Injectable data-access object — `find` / `create` / `update` / `delete` / `query()` / `exists` / `count` |
| `QueryBuilder<TModel>` | Fluent SELECT — `where` / `orderBy` / `limit` / `offset` / `select` / `get` / `first` / `count` / `pluck` |
| `emitInsert` / `emitUpdateById` / `emitDeleteById` / `emitFindById` / `emitFindMany` | SQL emitter helpers used by Repository — direct use for raw SQL emission with the same conventions |
| `quoteIdent` / `selectColumnList` | Building blocks the emitter uses; exposed for raw-SQL escape hatches |

## Documentation

- [`api.md`](./api.md) — every export with signature + semantics.
- [`guides/schemas.md`](./guides/schemas.md) — defining schemas, field types, modifiers, composites, tenancy flags, registry usage.
- [`guides/migrations.md`](./guides/migrations.md) — writing migrations, runner mechanics, batching + rollback semantics, transactional boundaries, why there's no auto-diff (yet).
- [`guides/repositories.md`](./guides/repositories.md) — Model + Repository<T> + QueryBuilder; the three-layer split; what's automatic (ULID, updated_at, RETURNING) vs deferred (hooks, soft deletes, relationships, pagination); testing patterns.
