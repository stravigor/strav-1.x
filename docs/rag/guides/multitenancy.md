# Multitenancy

The `rag_vector` table is `tenanted: true` — `@strav/database` auto-injects a `tenant_id` foreign key and emits RLS policies. Inside `tenants.withTenant(tenantId, fn)`, every query is scoped to that tenant at the database level. Cross-tenant leaks aren't possible from application code.

```ts
import { TenantManager } from '@strav/database'

const tenants = app.resolve(TenantManager)
const rag = app.resolve(RagManager)

await tenants.withTenant(workspace.id, async () => {
  // Every ingest + retrieve below sees only `workspace.id`'s vectors.
  await rag.ingest('articles', someContent, { sourceId: 'doc_1' })
  const { matches } = await rag.retrieve(userQuery, { collection: 'articles' })
})
```

## What you don't have to do

- **No tenant column in queries.** The driver issues plain `WHERE collection = $1` predicates. RLS adds `AND tenant_id = current_setting('app.tenant_id')` automatically.
- **No tenant column on INSERTs.** The framework's `tenant_id` is filled from the session setting at write time.
- **No tenant filter on retrieve.** Querying for `articles` under tenant A simply doesn't see tenant B's chunks — they fail the RLS check before reaching the HNSW index.

## Collection naming under tenancy

Apps that want **multiple collections per tenant** (e.g., `articles` vs `support_docs` inside one workspace) keep collection names as-is. Tenant isolation comes from the row-level `tenant_id` filter, not from the collection name.

Apps that want **per-tenant collection namespacing** (rare) set `config.rag.prefix` and resolve via `manager.collectionName('articles')`. With `prefix: 'tenant_42_'`, ingest goes to `tenant_42_articles`. Note that prefix is a static config — for dynamic per-request prefixing apps compose the collection name themselves.

## Cross-tenant operations

Some workflows are intentionally cross-tenant:

- A batch ingest job processing every tenant's articles in one pass.
- An admin tool that searches across tenants for compliance review.

The framework's `TenantManager.withoutTenant(fn)` runs without RLS scoping, but **requires a BYPASSRLS connection pool** to be configured. Apps that need this register a second `PostgresDatabase` with elevated privileges and route admin-tier requests through it.

```ts
await tenants.withoutTenant(async () => {
  // No tenant_id filter — sees every row. Use sparingly.
})
```

Avoid this for app-server request handlers. The pattern is for migrations, cleanup commands, and explicitly-admin tooling.

## Per-tenant cleanup

Dropping every vector belonging to one tenant:

```ts
await tenants.withTenant(deletedTenantId, async () => {
  await db.execute(`DELETE FROM "rag_vector"`)
})
```

The RLS policy filters the DELETE to the active tenant — no cross-tenant deletion is possible from this code path.

If the entire tenant row is being removed, the `tenant_id` FK with `ON DELETE CASCADE` (default for `tenanted: true` schemas) drops every vector automatically.

## Testing multitenancy

The `MemoryDriver` is single-tenant by construction — it doesn't model RLS. Tests that need to verify tenant isolation run against real Postgres + pgvector via `bun test:integration`. The auth + queue + brain packages follow the same pattern.

For unit tests where tenant isolation isn't under test, `MemoryDriver` is faster and simpler — just don't conclude anything about tenancy behavior from a memory-driver run.
