# Migrations — runner mechanics and authoring

`MigrationRunner` applies, rolls back, and reports on database migrations. Each migration is a plain object the runner sorts alphabetically by `name` — adopt the `YYYYMMDDHHMMSS_short_description` convention so the order is also a timeline.

## Authoring a migration

The DDL emitters generate `CREATE TABLE` / `ALTER TABLE` SQL from a schema, so migrations stay in lock-step with the schema definition:

```ts
// database/migrations/20260528103000_create_users.ts
import { emitCreateTable, emitDropTable, type Migration } from '@strav/database'
import { userSchema } from '../schemas/user_schema.ts'

export const migration: Migration = {
  name: '20260528103000_create_users',
  async up(db) {
    await db.execute(emitCreateTable(userSchema).sql)
    await db.execute(`CREATE INDEX idx_user_email ON "user" (email)`)
  },
  async down(db) {
    await db.execute(emitDropTable(userSchema.name).sql)
  },
}
```

When the schema has reference fields, thread the registry so FK column types resolve:

```ts
async up(db) {
  await db.execute(emitCreateTable(postSchema, { registry: schemas }).sql)
}
```

Raw SQL still works — the emitters are an opt-in convenience:

```ts
async up(db) {
  await db.execute(`
    CREATE TABLE "user" (
      id          char(26)     PRIMARY KEY,
      email       varchar(320) NOT NULL UNIQUE,
      created_at  timestamptz  NOT NULL DEFAULT now()
    )
  `)
}
```

Indexes aren't part of the Schema, but the DDL emitters cover them too — use `emitCreateIndex` / `emitDropIndex` alongside the schema-driven calls:

```ts
import {
  emitCreateIndex,
  emitCreateTable,
  emitDropIndex,
  emitDropTable,
  type Migration,
} from '@strav/database'

export const migration: Migration = {
  name: '20260601000000_create_users_with_indexes',
  async up(db) {
    await db.execute(emitCreateTable(userSchema).sql)
    await db.execute(emitCreateIndex('user', ['email']).sql)
    // Partial unique index — the right idiom for soft-delete + unique:
    await db.execute(
      emitCreateIndex('user', ['email'], {
        unique: true,
        where: '"deleted_at" IS NULL',
        name: 'user_email_active_idx',
      }).sql,
    )
  },
  async down(db) {
    await db.execute(emitDropIndex('user_email_active_idx', { ifExists: true }).sql)
    await db.execute(emitDropIndex('user_email_idx', { ifExists: true }).sql)
    await db.execute(emitDropTable(userSchema.name).sql)
  },
}
```

Renames have their own emitters — `emitRenameTable(from, to)` and `emitRenameColumn(table, from, to)` — for shape-preserving migrations. ALTER COLUMN type changes need backfill design and are still hand-written.

Two methods:

- `up(db)` applies the change.
- `down(db)` reverses it. Migrations that can't be reversed (data destruction) throw — the runner records that as a rollback failure rather than silently doing nothing.

The `db` parameter is a `DatabaseExecutor` — same `query` / `queryOne` / `execute` surface as the top-level `Database`, but scoped to the per-migration transaction the runner opens.

## Running via the CLI

For apps using `@strav/cli`, the migrate commands wrap the runner and auto-discover migration files from `config.database.migrationsPath` (default `'database/migrations/**/*.ts'`):

```bash
bun strav migrate            # apply pending migrations
bun strav migrate:rollback   # roll back the last batch
bun strav migrate:rollback --batch=2   # roll back the last two batches
bun strav migrate:rollback --batch=all # roll back everything
bun strav migrate:status     # table of applied + pending
bun strav migrate:fresh      # APP_ENV=local|testing only — drops public schema then migrates
bun strav migrate:generate -m "add users"   # diff schemas vs DB → write a migration file
```

Add `DatabaseConsoleProvider` to your `bootstrap/providers.ts` so the commands resolve:

```ts
import { DatabaseConsoleProvider, DatabaseProvider } from '@strav/database'

export const providers = [
  new DatabaseProvider(),
  new DatabaseConsoleProvider(),
  // …
]
```

`MigrationRunner` is bound by `DatabaseProvider` as an empty singleton; the commands call `resolveMigrationRunner(app)` which runs `runner.discover(path)` on demand. Non-console boots (web server, queue worker) don't pay the discovery cost.

## Registering manually

```ts
import { MigrationRunner, PostgresDatabase } from '@strav/database'
import { migration as createUsers } from '../database/migrations/20260528103000_create_users.ts'
import { migration as createLeads } from '../database/migrations/20260528103100_create_leads.ts'

const runner = new MigrationRunner(app.resolve(PostgresDatabase))
runner.registerAll([createUsers, createLeads])

const result = await runner.migrate()
// → { applied: ['20260528103000_create_users', '20260528103100_create_leads'], batch: 1 }
```

Order at registration time doesn't matter — execution is alphabetical by `name`. `runner.discover('database/migrations/*.ts')` is the auto-discovery alternative; it imports each file and registers every value that looks like a `Migration`.

## The tracking table

`_strav_migrations` is created lazily by every public method:

```sql
CREATE TABLE _strav_migrations (
  name        text         PRIMARY KEY,
  batch       integer      NOT NULL,
  applied_at  timestamptz  NOT NULL DEFAULT now()
)
```

You don't write the migration that creates it; the runner handles it.

## Batches

Every migration applied in one `migrate()` call shares a batch number. The first call is batch 1; subsequent calls increment.

`rollback()` undoes **one batch** — the most-recently-applied set, in reverse alphabetical order. This is the operationally-correct shape: deploys ship as a batch, rollbacks undo a deploy.

```ts
await runner.migrate()        // batch 1: a, b, c
await runner.migrate()        // batch 2: d
await runner.rollback()       // undoes d only — batch 2
await runner.rollback()       // undoes c, b, a — batch 1
```

## Transactional boundaries

Each migration's `up()` / `down()` runs in **its own transaction**, alongside the tracking-table insert/delete:

```
BEGIN
  -- migration body (CREATE TABLE foo, etc.)
  INSERT INTO _strav_migrations (name, batch) VALUES ($1, $2)
COMMIT
```

So the tracking row only lands when the migration body commits — partial state is impossible per-migration.

The overall `migrate()` call is **NOT** one transaction. Two reasons:

1. **DDL inside one big transaction locks the entire schema** for the duration. With many migrations, that's a long lock.
2. **Partial progress is recoverable.** If migration 3 of 7 fails, migrations 1 and 2 are committed; you fix the code, re-run, and pick up from migration 3.

If you need cross-migration atomicity, that's typically a sign the changes should be one migration with multiple statements.

## `status()` — what's applied, what's pending

```ts
const status = await runner.status()
// {
//   applied: [{ name, batch, applied_at }, ...],
//   pending: ['20260528103100_create_leads', ...]
// }
```

Useful for `bun strav db:status` (which lands with `@strav/cli`'s db integration).

## Rolling back

`rollback()` returns `{ rolled_back, batch }` where `rolled_back` is the names that ran their `down()` and `batch` is the batch that was undone. `batch: 0` means nothing was applied.

**Important:** if the database has an applied migration whose code isn't registered with the runner, `rollback()` **throws**. This is by design — the runner refuses to delete the tracking row for a migration it can't actually undo. The fix is to register every historical migration, even ones from years ago, so the runner's view matches the database's.

## Auto-generated migrations

`generateMigration({ registry, db })` does the additive 80% for you — new tables and new columns from registered Schemas, in topological FK order. See [`migration_generator.md`](./migration_generator.md) for the full walkthrough. The console wrapper (`bun strav make:migration`) lands with `@strav/cli`; today, call the function from a script.

Destructive operations (drops, renames, type changes) stay hand-written until the destructive-diff slice ships — the additive baseline is safe by construction.

## Testing migrations without Postgres

The package ships an `InMemoryDatabase` stub at `packages/database/tests/in_memory_database.ts`. It simulates the runner's tracking queries and records every other SQL string a migration runs — sufficient for asserting "this migration tried to CREATE TABLE foo" without spinning up Postgres. See the unit suite for usage patterns.

Real integration tests (running migrations against an actual Postgres) need CI setup with a test database, separately from the package's unit tests.
