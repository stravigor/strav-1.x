# Migration generator — diffing schemas vs the live DB

`generateMigration({ registry, db })` walks every Schema you've registered and compares it against `information_schema`. If anything is missing (a whole table, or columns on an existing table), it returns a ready-to-register `Migration`. If nothing is missing, it returns `null`.

By default the generator is **additive only** — new tables and new columns are detected and emitted; drops and renames are opt-in via `{ allowDrop: true }` and `{ renames: … }`. Type changes are still deferred (they need `USING` clauses or backfill semantics).

## Quick example

```ts
import { generateMigration, MigrationRunner, PostgresDatabase, SchemaRegistry } from '@strav/database'
import { userSchema } from '../database/schemas/user_schema.ts'
import { postSchema } from '../database/schemas/post_schema.ts'

const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
const db = app.resolve(PostgresDatabase)

const generated = await generateMigration({ registry, db })
if (!generated) {
  console.log('database is up to date')
} else {
  // Preview what's about to run.
  for (const op of generated.diff.operations) {
    console.log(`-- ${op.kind}: ${op.schemaName}`)
    console.log(op.sql)
  }

  // Hand it to the runner like any other migration.
  const runner = new MigrationRunner(db).register(generated.migration)
  await runner.migrate()
}
```

In the typical flow, you'd preview the diff (`--dry-run`), write the migration file with the inferred contents, then run it as a normal migration. The CLI command `bun strav make:migration` (lands with `@strav/cli`) wraps this loop.

## How introspection works

`inspectDatabase(db)` issues one query:

```sql
SELECT
  t.table_name,
  c.column_name,
  c.data_type,
  c.character_maximum_length,
  c.is_nullable,
  c.column_default
FROM information_schema.tables t
LEFT JOIN information_schema.columns c
  ON c.table_schema = t.table_schema AND c.table_name = t.table_name
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND t.table_name <> '_strav_migrations'
ORDER BY t.table_name, c.ordinal_position
```

The framework's own tracking table is filtered out. The result is grouped client-side into a `DbSnapshot { tables: Map<name, TableInfo> }`. Multi-schema (multiple Postgres `schema_name`s) is hard-coded to `public` today; multi-schema support lands with the multi-tenancy slice.

## Operation ordering

`diffSchemas` produces operations in two passes:

1. **`create-table` ops first**, topologically sorted by FK references. A table that references another schema in the to-create set comes AFTER its target. So `User → Post(author_id)` always emits `CREATE TABLE "user"` before `CREATE TABLE "post"`, regardless of how you registered them.
2. **`add-column` ops second.** A new column that REFERENCES a freshly-created table sees its target already in place.

References to schemas that aren't in the to-create set impose no ordering constraint — either the target already exists in the DB, or it's an external table.

## FK cycles

If two missing tables reference each other (A → B and B → A), no single `CREATE TABLE` order satisfies both. `diffSchemas` throws with a clear message rather than emitting a guaranteed-to-fail migration. Two ways to resolve:

```ts
// Option 1 — make one reference nullable, add it later.
const a = defineSchema('a', Archetype.Entity, (t) => {
  t.id()
  // FK to b deferred — added in a follow-up migration
})
const b = defineSchema('b', Archetype.Entity, (t) => {
  t.id()
  t.reference('a_id').to(a)
})
// Run the generator. Later, hand-write a migration that adds the FK from a → b.
```

```ts
// Option 2 — write the migration by hand with DEFERRABLE constraints.
async up(db) {
  await db.execute(`CREATE TABLE a (id char(26) PRIMARY KEY, b_id char(26))`)
  await db.execute(`CREATE TABLE b (id char(26) PRIMARY KEY, a_id char(26) REFERENCES a (id))`)
  await db.execute(`ALTER TABLE a ADD CONSTRAINT a_b_id_fk FOREIGN KEY (b_id) REFERENCES b (id)`)
}
```

Resolving cycles automatically lands with the multi-step migration generator slice.

## Destructive ops (opt-in)

By default, dropped tables / columns are reported in `result.unknownTables` but NOT emitted as ops — drops are dangerous and need explicit consent.

```ts
const generated = await generateMigration({
  registry,
  db,
  allowDrop: true,    // emit drop-table + drop-column ops
})
```

When `allowDrop` is on, the diff emits:
- **`drop-table`** for every table in the DB that no schema in the registry claims.
- **`drop-column`** for every column on a known table that no schema field claims.

Drops emit AFTER all additions and reverse-alphabetically among themselves — apps that need fine-grained ordering (e.g., to satisfy `ON DELETE RESTRICT` FKs) should write the migration by hand or run multiple migrations.

## Renames

A rename from `display_name` → `handle` is indistinguishable from `drop display_name + add handle` from a diff standpoint. Apps declare renames explicitly via the `renames` option, which the diff applies BEFORE drop detection:

```ts
const generated = await generateMigration({
  registry,
  db,
  renames: {
    tables: { users: 'user' },                    // rename users → user
    columns: {
      user: { email_address: 'email' },           // keyed by SCHEMA name (post-table-rename)
    },
  },
})
```

The diff produces `rename-table` / `rename-column` ops instead of drop+add pairs. Down-migration reverses the rename.

`renames` and `allowDrop` compose — declare the renames you mean, then turn on `allowDrop` to also clean up the unrelated leftovers.

## What's still not detected

- **Type / nullability / default changes** on existing columns. ALTER COLUMN semantics need a `USING` clause or backfill strategy that the diff can't infer. Apps write these migrations explicitly.
- **Indexes** — schemas don't declare them today. Indexes added via `emitCreateIndex` aren't introspected back into the schema.
- **Standalone FK / CHECK / UNIQUE constraints** beyond what columns capture inline.

## down()

The generated `Migration` has a `down()` that reverses the ops:

- `add-column` → `ALTER TABLE … DROP COLUMN IF EXISTS …`
- `create-table` → `DROP TABLE IF EXISTS …`
- `rename-table` / `rename-column` → reverse-rename
- `drop-table` / `drop-column` → **no-op** (the diff discarded the original schema definition; apps recreate the entity by hand if they need to undo a drop)

Reverse order. Apps with rollback-critical migrations should write them by hand.

## When to use this vs hand-written migrations

| | Generator | Hand-written |
|---|---|---|
| New table from a schema | ✓ | extra effort |
| New column on a schema | ✓ | extra effort |
| Custom indexes / partial indexes | — | ✓ |
| Data backfill | — | ✓ |
| Type changes with `USING` clauses | — | ✓ |
| Renames | — | ✓ |
| Drops | — | ✓ |
| Tenancy / RLS plumbing | — (lands with tenancy slice) | ✓ |

The pattern that works: run the generator for the additive 80%, hand-write the 20% that needs careful semantics. Both kinds of migration go through the same `MigrationRunner.register(...)`.
