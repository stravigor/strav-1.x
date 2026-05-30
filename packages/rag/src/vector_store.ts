/**
 * `VectorStore` — the storage abstraction every driver
 * (`MemoryDriver`, `PgvectorDriver`, custom drivers registered
 * via `rag.extend(...)`) implements.
 *
 * Lifecycle:
 *
 *   - `createCollection(name, dimension)` — idempotent. For
 *     pgvector this is mostly a no-op (the table holds every
 *     collection); the dimension is enforced at INSERT.
 *   - `deleteCollection(name)` — drops every vector under
 *     `collection = name`.
 *
 * Reads + writes:
 *
 *   - `upsert(collection, docs)` — inserts (and overwrites by id
 *     when supplied).
 *   - `delete(collection, ids)` — removes specific vectors.
 *   - `deleteBySource(collection, sourceId)` — removes every
 *     vector with the matching `source_id`. Apps call this when
 *     re-indexing a source row.
 *   - `flush(collection)` — drops every vector in the
 *     collection. Faster than `deleteCollection` for the common
 *     "wipe + re-ingest" pattern because the collection's
 *     identity stays intact.
 *   - `query(collection, vector, opts)` — top-K similarity
 *     search.
 *
 * Multitenancy lives BELOW this interface — the pgvector driver
 * relies on `app.tenant_id` session settings (set by
 * `tenants.withTenant`) to enforce isolation via RLS. The
 * `MemoryDriver` is single-tenant by construction and ignores
 * tenancy.
 */

import type { QueryOptions, QueryResult, VectorDocument } from './types.ts'

export interface VectorStore {
  /** Driver identifier — `'memory'`, `'pgvector'`, or the name passed to `rag.extend`. */
  readonly name: string

  createCollection(collection: string, dimension: number): Promise<void>
  deleteCollection(collection: string): Promise<void>

  upsert(collection: string, documents: readonly VectorDocument[]): Promise<void>
  delete(collection: string, ids: readonly string[]): Promise<void>
  deleteBySource(collection: string, sourceId: string): Promise<void>
  flush(collection: string): Promise<void>

  query(collection: string, vector: readonly number[], options?: QueryOptions): Promise<QueryResult>
}
