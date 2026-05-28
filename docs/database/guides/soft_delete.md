# Soft delete — `t.softDeletes()`, `withTrashed`, `restore`

Soft delete is one schema flag. `t.softDeletes()` adds a nullable `deleted_at` column. Everything else — the `UPDATE deleted_at = now()` on delete, the default scope that excludes trashed rows, `restore()`, `forceDelete()` — wires up automatically.

```ts
const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.softDeletes()       // ← adds `deleted_at timestamptz` (nullable)
  t.timestamps()
})
```

## What changes

| Operation | Schema with `softDeletes()` | Schema without |
|---|---|---|
| `repo.delete(model)` | `UPDATE … SET deleted_at = now() RETURNING *` → returns the trashed Model | `DELETE FROM …` |
| `repo.find(id)` | Skips trashed rows (returns `null`) | Returns whatever's in the table |
| `repo.findMany(ids)` | Skips trashed rows | Returns matches |
| `repo.query().get()` | `WHERE deleted_at IS NULL …` | No extra predicate |
| `repo.forceDelete(model)` | `DELETE FROM …` (irreversible) | Same as `delete` |
| `repo.restore(model)` | `UPDATE … SET deleted_at = NULL` | Throws (no column to clear) |
| `repo.query().withTrashed()` | Drops the predicate; all rows including trashed | No effect |
| `repo.query().onlyTrashed()` | `WHERE deleted_at IS NOT NULL` | Throws |

## Lifecycle events

`delete`, `forceDelete`, `restore` all emit the standard cancelable-before + post-event pair:

| Event | Payload | Fires on |
|---|---|---|
| `<resource>.deleting` | `{ resource, model, force }` | both `delete` (soft, `force: false`) and `forceDelete` (hard, `force: true`) |
| `<resource>.deleted` | `{ resource, model, force }` | both paths after success |
| `<resource>.restoring` | `{ resource, model }` | `restore` only |
| `<resource>.restored` | `{ resource, model }` | `restore` only |

Cancelable `<verb>ing` events still abort via throw — a `user.deleting` listener that throws stops both the soft-delete UPDATE and the hard DELETE. Post-events fire after the SQL succeeds.

Inside `UnitOfWork.run` (or `TenantManager.withTenant`), post-events queue and flush on commit — `.deleted` only fires for transactions that committed. Same semantic as the other lifecycle events.

```ts
events.on('user.deleted', ({ model, force }) => {
  if (force) {
    // Hard delete — row is gone.
    searchIndex.remove(model.id)
  } else {
    // Soft delete — model.deleted_at is set, row still in DB.
    searchIndex.markTrashed(model.id)
  }
})

events.on('user.restored', ({ model }) => {
  searchIndex.markActive(model.id)
})
```

## When to use which

- **`repo.delete(model)`** — the right default for user-facing "delete this" actions. Reversible via `restore`. Trashed rows still exist in the DB, just hidden from default queries.
- **`repo.forceDelete(model)`** — GDPR-style "wipe this row entirely." Irreversible. Apps that need this typically gate it behind a user confirmation step.
- **`repo.restore(model)`** — undo soft-delete. Standard "trash bin" UIs: list `onlyTrashed()`, click restore.

## Querying trashed rows

```ts
// Default — excludes trashed.
const active = await users.query().where('email', 'like', '%@acme.com').get()

// Include trashed (e.g., admin audit view).
const everyone = await users.query().withTrashed().get()

// Only trashed (e.g., trash bin UI).
const trash = await users.query().onlyTrashed().orderBy('deleted_at', 'desc').get()
```

The default scope flows through every terminal — `get`, `first`, `firstOrFail`, `count`, `exists`, `pluck` — because they all share `compileWhere`. `repo.find(id)` and `repo.findMany(ids)` route through QueryBuilder too, so they pick up the scope as well.

## The "find by id including trashed" pattern

`repo.find(id)` returns `null` for trashed rows. To look up a row that might be trashed (typical for admin views and restore workflows):

```ts
const user = await users.query().withTrashed().where('id', userId).first()
```

A `findWithTrashed(id)` shortcut on Repository is a possible follow-up but not part of V1.

## Tradeoffs to know

- **Soft-deleted rows still occupy storage + indexes.** `t.softDeletes()` is the wrong choice for high-volume tables you don't actually need to recover (log rows, ephemeral events). Use `forceDelete` or a non-soft-delete schema in those cases.
- **Unique constraints don't know about soft-delete.** If `email` is `UNIQUE` and a user is soft-deleted, you can't reuse that email — the row still exists. Postgres partial unique indexes (`UNIQUE (email) WHERE deleted_at IS NULL`) solve this; write the index in the migration by hand. The migration builder DSL slice will add ergonomic support.
- **Cascading soft-delete isn't automatic.** Deleting a `user` doesn't auto-soft-delete their `post`s. Apps that need cascade-soft-delete listen on `user.deleted` and soft-delete the children — or use Postgres FK `ON DELETE CASCADE` for hard delete only.
- **Foreign keys still constrain hard-delete.** `forceDelete` honors the FK definition — if other rows reference yours via `ON DELETE RESTRICT`, the DELETE will fail.

## What's NOT here

Each is its own follow-up slice:

- **Automatic cascading soft-delete** across `t.reference(...)` edges.
- **`findWithTrashed(id)` / `findOnlyTrashed(id)` shortcuts** on Repository — apps go through `query().withTrashed().where('id', id).first()` today.
- **Partial unique-index emission** — when a schema has both `t.softDeletes()` and a `.unique()` field, the migration generator could emit `UNIQUE (email) WHERE deleted_at IS NULL` instead of plain `UNIQUE`. Lands with the migration builder DSL.
- **`Repository.pruneTrashed(olderThan)`** for bulk cleanup of old soft-deleted rows — trivial to layer on top, lands when the use case shows up.
