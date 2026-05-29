# Custom drivers

The `VectorStore` interface is small; apps that need to plug in Qdrant, Pinecone, Weaviate, or any other vector backend implement it and register the factory with `manager.extend(...)`.

## The contract

```ts
import type { VectorStore } from '@strav/rag'

export class QdrantDriver implements VectorStore {
  readonly name = 'qdrant'

  async createCollection(collection: string, dimension: number): Promise<void> { /* … */ }
  async deleteCollection(collection: string): Promise<void> { /* … */ }
  async upsert(collection: string, documents: readonly VectorDocument[]): Promise<void> { /* … */ }
  async delete(collection: string, ids: readonly string[]): Promise<void> { /* … */ }
  async deleteBySource(collection: string, sourceId: string): Promise<void> { /* … */ }
  async flush(collection: string): Promise<void> { /* … */ }
  async query(collection: string, vector: readonly number[], options?: QueryOptions): Promise<QueryResult> { /* … */ }
}
```

## Score normalization

Drivers MUST return cosine similarity mapped to `[0, 1]` (1 = identical, 0.5 = orthogonal, 0 = opposite). The built-in drivers already do this:

- **MemoryDriver**: `(cos + 1) / 2`.
- **PgvectorDriver**: `(1 - (a <=> b) + 1) / 2`.

Custom drivers that use a different distance function (Euclidean, dot product) need to project into the same range so app-side `threshold` comparisons remain meaningful across drivers.

## Filter semantics

V1's filter is a flat key/value AND. Drivers MUST honor it; nested filters and operators (`$gt`, `$in`) aren't part of the V1 contract. Apps that need richer filtering today either:

- Drop down to driver-specific raw queries via the driver's native client.
- Apply post-filter in their own code after `query()` returns.

## Registering

```ts
const rag = app.resolve(RagManager)

rag.extend('qdrant', (config) => new QdrantDriver({
  url: env('QDRANT_URL'),
  apiKey: env('QDRANT_API_KEY'),
  ...config,
}))
```

Configure the store in `config/rag.ts`:

```ts
{
  default: 'qd',
  stores: {
    qd: { driver: 'qdrant', /* driver-specific fields */ },
  },
  // ...
}
```

The `RagManager` resolves `stores.qd.driver = 'qdrant'`, looks up the registered factory, calls it with the full `StoreConfig`, and memoizes the returned `VectorStore`.

## Multitenancy on a custom backend

Backends that aren't Postgres-RLS-aware enforce tenancy themselves. Two patterns:

1. **Tenant-as-collection-prefix**. Inside `withTenant(tenantId, ...)`, the driver prepends the tenant id to the collection: `articles` → `tenant_42_articles`. Cross-tenant queries become impossible because the collections don't even share keyspaces.

2. **Tenant-as-filter**. The driver reads the active tenant from some shared state and adds it as a mandatory filter on every query. Easier to misimplement (one missed code path → leak).

Pattern (1) is safer. The driver can read the active tenant by injecting `TenantManager` and calling `tenants.currentTenant()`.

## Lifecycle integration

Custom drivers that manage long-lived connections (HTTP clients with keepalive, gRPC channels) implement a `close()` method and register a shutdown callback:

```ts
app.shutdown(async () => {
  await driver.close()
})
```

The `VectorStore` interface doesn't require `close()` — it's optional and only relevant to drivers that own resources.
