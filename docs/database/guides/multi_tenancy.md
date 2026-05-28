# Multi-tenancy — RLS-backed tenant isolation

Strav's multi-tenancy is **row-level**: a single set of tables, every tenanted row carries a `<registry>_id` FK, Postgres RLS policies scope every query by `current_setting('app.tenant_id')`. At runtime, `TenantManager.withTenant(id, fn)` binds the GUC inside a transaction and the policies do the rest.

This guide is the application-developer entry point. For API reference see [`api.md`](../api.md#multi-tenancy).

## Concepts

- **Tenant registry table.** Exactly one schema is flagged `tenantRegistry: true`. Conventionally `tenant`, but `org`, `workspace`, etc. work the same — the column name (`tenant_id`, `org_id`, …) derives from the registry's table name.
- **Tenanted schemas.** Schemas flagged `tenanted: true`. The DDL emitter injects the FK column + RLS policy automatically; you never write the plumbing.
- **`app.tenant_id` Postgres GUC.** A per-transaction setting that the RLS policies read. `TenantManager` sets it via `SELECT set_config('app.tenant_id', $1, true)` inside the transaction (the `true` makes it transaction-local — auto-clears on COMMIT/ROLLBACK).
- **Two Postgres roles.** App code runs as a `NOBYPASSRLS` role so policies apply. Migrations + admin run as a `BYPASSRLS` role (otherwise they couldn't see other tenants' rows or set up RLS in the first place). Today, apps configure both manually; framework-managed dual roles land later.

## Schemas

```ts
// database/schemas/tenant_schema.ts
import { Archetype, defineSchema } from '@strav/database'

export const tenantSchema = defineSchema('tenant', Archetype.Entity, (t) => {
  t.id()
  t.string('name').max(120)
  t.string('slug').max(64).unique()
  t.timestamps()
}, { tenantRegistry: true })

// database/schemas/post_schema.ts
export const postSchema = defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.string('title').max(255)
  t.text('body')
  t.timestamps()
}, { tenanted: true })   // ← that's all
```

Register both with the `SchemaRegistry` in your provider — `emitCreateTable` looks up the registry to learn the tenant table's name + PK type.

## Migration

`emitCreateTable(postSchema, { registry })` emits the full multi-statement string. Run it as one `db.execute(...)`:

```ts
// database/migrations/20260528150000_create_tenants.ts
import { emitCreateTable, emitDropTable, type Migration } from '@strav/database'
import { tenantSchema } from '../schemas/tenant_schema.ts'

export const migration: Migration = {
  name: '20260528150000_create_tenants',
  async up(db) {
    await db.execute(emitCreateTable(tenantSchema, { registry: schemas }).sql)
  },
  async down(db) {
    await db.execute(emitDropTable(tenantSchema.name).sql)
  },
}

// database/migrations/20260528150100_create_posts.ts
export const migration: Migration = {
  name: '20260528150100_create_posts',
  async up(db) {
    await db.execute(emitCreateTable(postSchema, { registry: schemas }).sql)
  },
  async down(db) {
    await db.execute(emitDropTable(postSchema.name).sql)
  },
}
```

The migration must run as the `BYPASSRLS` role — otherwise the `ALTER TABLE … ENABLE ROW LEVEL SECURITY` statement and the inserts done by app code would interact badly during deploy.

## Runtime

```ts
import { EventBus } from '@strav/kernel'
import { PostgresDatabase, TenantManager } from '@strav/database'

const tenants = new TenantManager(app.resolve(PostgresDatabase), app.resolve(EventBus))

// In a request handler:
await tenants.withTenant(currentUserTenantId, async () => {
  const posts = await postRepository.all()  // ← auto-routes through the tenant tx
  return ctx.response.ok(posts)
})
```

Repository calls inside `withTenant` automatically use the transaction-scoped executor (via the unit-of-work slice's AsyncLocalStorage). Raw `tx.query(...)` still works for custom SQL — `tx` is the second argument to your callback:

```ts
await tenants.withTenant(currentUserTenantId, async (tx) => {
  const rows = await tx.query('SELECT id, title FROM "post" ORDER BY created_at DESC')
  return ctx.response.ok(rows)
})
```

Post-events (`.created` / `.updated` / `.deleted`) queue inside `withTenant` and flush at commit — a throw inside the callback rolls back the transaction AND drops the event queue.

## `withoutTenant` — admin paths

```ts
await tenants.withoutTenant(async (tx) => {
  // Cross-tenant query — requires the BYPASSRLS role.
  await tx.execute('UPDATE "post" SET archived_at = now() WHERE created_at < $1', [cutoff])
})
```

If the underlying Database is wired with a `NOBYPASSRLS` role, this query returns nothing (the empty `app.tenant_id` filters everything out). Apps that need cross-tenant queries wire a second `DatabaseProvider` against the bypass role and construct a separate `TenantManager` over it.

## Advisory locks — `withTenantLock` / `withLock`

Postgres **transaction-level advisory locks** let you serialize concurrent work without a heavyweight row lock. The lock auto-releases at COMMIT/ROLLBACK — pool-safe by construction (no stranded session locks if a worker crashes), and the key is just an integer derived from `hashtext(...)` on the names you pass in.

```ts
// One worker at a time PROCESSES INVOICES for this tenant. Other tenants
// holding the same key don't contend — the (tenant_id, lockKey) pair is
// partitioned by Postgres's two-arg pg_advisory_xact_lock(int, int).
await tenants.withTenantLock(tenantId, 'invoice-batch', async (tx) => {
  const pending = await invoiceRepo.query().where('status', 'pending').all()
  for (const invoice of pending) await processInvoice(invoice)
})

// Fleet-wide singleton — only one worker across the whole deployment
// runs this block at once. No tenant binding, so RLS-protected tables
// need the BYPASSRLS connection. Useful for cron singletons / one-time
// migrations / leadership fences.
await tenants.withLock('housekeeping:expire-tokens', async (tx) => {
  await tx.execute('DELETE FROM "token" WHERE expires_at < now()')
})
```

`withTenantLock` is `withTenant` + the lock — same nested-tenant rules (matching tenant → reuse outer tx, different tenant → throws). Inside the callback, Repository calls auto-route through the transaction.

If you call `withTenantLock` inside an existing `withTenant`, the lock is acquired on the existing transaction — no nested transaction opened. Multiple locks in the same scope compose (Postgres allows many advisory locks per transaction); they all release together at COMMIT/ROLLBACK.

## Two Postgres roles

Until the framework ships dual-role config, do it manually:

```sql
-- One-time, as a superuser
CREATE ROLE strav_app NOBYPASSRLS LOGIN PASSWORD 'app-password';
GRANT CONNECT ON DATABASE myapp TO strav_app;
GRANT USAGE ON SCHEMA public TO strav_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO strav_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO strav_app;

CREATE ROLE strav_admin BYPASSRLS LOGIN PASSWORD 'admin-password';
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO strav_admin;
```

App config:

```ts
// config/database.ts
export default {
  // App role — used by request handlers, RLS applies.
  url: env.required('DATABASE_URL'),  // postgres://strav_app:…@host/myapp
  max: 20,
  lazyConnect: true,
}

// config/database_admin.ts (separate provider)
export default {
  url: env.required('DATABASE_ADMIN_URL'),  // postgres://strav_admin:…@host/myapp
  max: 4,
}
```

Two `DatabaseProvider`s, two `PostgresDatabase` instances, two `TenantManager`s. The MigrationRunner uses the admin one.

## Production helpers

### Boot-time validation — `validateTenantRegistry(db, registry)`

Catches misconfigurations BEFORE the first query — missing registry table, wrong PK type, registry schema not declared.

```ts
import { validateTenantRegistry } from '@strav/database'

await app.start()
await validateTenantRegistry(app.resolve(PostgresDatabase), app.resolve(SchemaRegistry))
app.resolve(HttpKernel).serve(...)
```

Opt-in (apps without tenancy skip the call; the function no-ops on registries with no tenanted schemas). Throws `ConfigError` with specific messages: "registry not declared", "registry table missing from DB", "PK type mismatch (DB has X, schema declared Y)". The PK-type check is the load-bearing one — getting it wrong leads to cryptic RLS-policy errors at query time when the cast comparison silently fails.

### `current_tenant_id()` SQL function — `emitTenantIdFunction(registry)`

Generates a Postgres `STABLE` function that wraps `current_setting('app.tenant_id', true)::<pk_type>`. Apps run the DDL in their tenancy migration:

```ts
async up(db) {
  await db.execute(emitCreateTable(tenantSchema, { registry }).sql)
  await db.execute(emitCreateTable(postSchema, { registry }).sql)
  await db.execute(emitTenantIdFunction(registry).sql)
}
```

After that, raw-SQL paths use the function instead of inline casting:

```ts
// Before:
await tx.query(`SELECT * FROM "post" WHERE "tenant_id" = current_setting('app.tenant_id', true)::char(26)`)

// After:
await tx.query('SELECT * FROM "post" WHERE "tenant_id" = current_tenant_id()')
```

Outside `withTenant`, `current_tenant_id()` returns `NULL` (the `true` second arg to `current_setting` makes it missing-OK) — so the `WHERE` predicate matches nothing, same defensive failure as the RLS policy semantic.

## Common pitfalls

- **Forgetting `withTenant` in a non-tenanted code path.** RLS policies will reject every SELECT/INSERT/UPDATE/DELETE with "permission denied" — Postgres treats no policy match as a deny. Wrap the right scope: typically a middleware that calls `withTenant(ctx.user.tenant_id, …)` around the rest of the request.
- **Cross-tenant joins.** A query inside `withTenant('A', …)` can't see tenant B's rows even if the SQL explicitly references them — the policy filters at the table layer. For genuinely cross-tenant queries (reports, admin), use `withoutTenant` + the bypass role.
- **`set_config` outside a transaction.** If you call `set_config('app.tenant_id', X, false)` (the `false` makes it session-wide), the next request on the same connection sees the wrong tenant. The framework always uses `true` (transaction-local) — don't override that.
- **`tenanted: true` + `tenantRegistry: true` on the same schema.** Mutually exclusive — `defineSchema` throws. The registry table itself isn't tenant-scoped (it'd be a chicken/egg).

## What's NOT in V1

Each is its own follow-up slice:

- **Composite `(tenant_id, id)` PK for `t.tenantedBigSerial()`.** Today's tenanted schemas use `t.id()` (ULID), which is globally unique by construction. Per-tenant auto-incrementing sequences (the `tenantedBigSerial` case) need the per-tenant sequence + trigger plumbing — `t.tenantedBigSerial()` emits a plain `bigint NOT NULL PRIMARY KEY` today and is reserved for the follow-up slice.
- **Framework-managed dual-role config.** Apps wire two `DatabaseProvider`s manually today.
- **`generateMigration` tenancy awareness.** The diff doesn't yet add `tenant_id` + RLS to an existing table that's missing them. Apps that retrofit tenancy onto an existing table write the migration explicitly (use `emitRlsForTenanted` + a hand-written `ALTER TABLE … ADD COLUMN`).
- **Tenant-id rotation / impersonation.** Useful for admin tooling ("view as tenant X"). Trivial to layer on top of `withTenant`; not part of V1.
- **Tenant-id rotation / impersonation.** Useful for admin tooling ("view as tenant X"). Trivial to layer on top of `withTenant`; not part of V1.
