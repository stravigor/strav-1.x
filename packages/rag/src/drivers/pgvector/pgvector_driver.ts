/**
 * `PgvectorDriver` — `VectorStore` backed by Postgres + the
 * `pgvector` extension. Single table per app (`rag_vector` by
 * default), `collection` is a column inside it.
 *
 * Multitenancy: every query relies on RLS scoping by
 * `current_setting('app.tenant_id')`. Apps wrap calls in
 * `tenants.withTenant(tenantId, async () => { ... })` — the
 * driver itself has no tenant awareness.
 *
 * Why one table instead of one-per-collection:
 *
 *   - `defineSchema` doesn't support runtime table creation.
 *   - HNSW indexes work fine with `collection` as a leading
 *     column; if a collection grows past tens of millions and
 *     wants its own partial HNSW, that's a one-line follow-up
 *     migration.
 *   - One RLS policy, one set of grants, fewer surprises.
 *
 * Why this driver doesn't extend `Repository`:
 *
 *   - The framework repository hydrates rows into a `Model`, but
 *     `embedding vector(N)` isn't expressible in the framework's
 *     type system. The driver uses raw `db.query` / `db.execute`
 *     on the table and returns plain objects.
 *   - All vector ops (`<=>`, `vector_cosine_ops`) are
 *     pgvector-specific; the framework's query builder can't
 *     model them.
 */

import {
  currentTransactionalContext,
  type DatabaseExecutor,
  type PostgresDatabase,
} from '@strav/database'
import { VectorQueryError } from '../../rag_error.ts'
import type {
  QueryOptions,
  QueryResult,
  StoreConfig,
  VectorDocument,
  VectorMatch,
} from '../../types.ts'
import type { VectorStore } from '../../vector_store.ts'
import { ragVectorSchema } from '../../vectors/rag_vector_schema.ts'

export interface PgvectorDriverOptions {
  /** PostgresDatabase instance — typically resolved from the container. */
  db: PostgresDatabase
  /** Override table name. Defaults to `rag_vector`. */
  table?: string
}

export class PgvectorDriver implements VectorStore {
  readonly name = 'pgvector'

  private readonly db: PostgresDatabase
  private readonly table: string

  constructor(options: PgvectorDriverOptions) {
    this.db = options.db
    this.table = options.table ?? ragVectorSchema.name
  }

  /**
   * Factory used by `RagManager.createStore` — accepts the raw
   * `StoreConfig` from `config.rag.stores[<name>]` and resolves
   * the `db` from the container. Apps that want explicit control
   * `new PgvectorDriver({ db, table })` directly.
   */
  static fromConfig(db: PostgresDatabase, config: StoreConfig): PgvectorDriver {
    return new PgvectorDriver({
      db,
      ...(typeof config.table === 'string' ? { table: config.table } : {}),
    })
  }

  /**
   * Route reads + writes through the ambient `UnitOfWork`
   * transaction when one is active (e.g., inside
   * `tenants.withTenant(...)`); fall back to the raw pool
   * otherwise. Mirrors how `Repository.executor(opts)` works in
   * `@strav/database`, so RLS scoping + transactional event
   * flushing apply uniformly across framework + driver code.
   */
  private exec(): DatabaseExecutor {
    const ambient = currentTransactionalContext()
    if (ambient) return ambient.tx
    return this.db as unknown as DatabaseExecutor
  }

  // ─── Collections ──────────────────────────────────────────────────────

  async createCollection(_collection: string, _dimension: number): Promise<void> {
    // No-op: every collection lives in the same table. The
    // `applyRagVectorMigration` helper attached the
    // `vector(<dimension>)` column at migration time, so the
    // dimension is fixed per table and enforced at INSERT.
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.exec().execute(`DELETE FROM "${this.table}" WHERE "collection" = $1`, [collection])
  }

  // ─── Mutations ────────────────────────────────────────────────────────

  async upsert(collection: string, documents: readonly VectorDocument[]): Promise<void> {
    if (documents.length === 0) return
    // pgvector accepts the vector as a stringified array literal —
    // `[0.12,0.34,...]` — cast with `::vector` at the boundary.
    //
    // Tenant scoping: the `tenant_id` column on `rag_vector` is
    // NOT NULL with no default, so apps wrapping the call in
    // `tenants.withTenant(...)` need a value supplied. We read
    // `current_setting('app.tenant_id')` inside the SQL itself —
    // the same session var the RLS policy reads — so the INSERT
    // works under tenant scope without the driver knowing the PK
    // type ahead of time. The `true` second arg makes the
    // setting return NULL (not throw) outside `withTenant`; the
    // INSERT then fails the NOT NULL constraint with a clear
    // error message that nudges the app toward the right wrap.
    for (const doc of documents) {
      const id = doc.id ?? crypto.randomUUID()
      const embeddingLiteral = `[${doc.embedding.join(',')}]`
      await this.exec().execute(
        `INSERT INTO "${this.table}"
          ("id", "tenant_id", "collection", "source_id", "content", "metadata", "embedding", "created_at")
         VALUES ($1, current_setting('app.tenant_id', true), $2, $3, $4, $5::jsonb, $6::vector, NOW())
         ON CONFLICT ("id") DO UPDATE SET
           "collection" = EXCLUDED."collection",
           "source_id"  = EXCLUDED."source_id",
           "content"    = EXCLUDED."content",
           "metadata"   = EXCLUDED."metadata",
           "embedding"  = EXCLUDED."embedding"`,
        [
          id,
          collection,
          doc.sourceId ?? null,
          doc.content,
          JSON.stringify(doc.metadata ?? {}),
          embeddingLiteral,
        ],
      )
    }
  }

  async delete(collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ')
    await this.exec().execute(
      `DELETE FROM "${this.table}" WHERE "collection" = $1 AND "id" IN (${placeholders})`,
      [collection, ...ids],
    )
  }

  async deleteBySource(collection: string, sourceId: string): Promise<void> {
    await this.exec().execute(
      `DELETE FROM "${this.table}" WHERE "collection" = $1 AND "source_id" = $2`,
      [collection, sourceId],
    )
  }

  async flush(collection: string): Promise<void> {
    await this.exec().execute(`DELETE FROM "${this.table}" WHERE "collection" = $1`, [collection])
  }

  // ─── Query ────────────────────────────────────────────────────────────

  async query(
    collection: string,
    vector: readonly number[],
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const start = performance.now()
    const topK = options.topK ?? 5
    const threshold = options.threshold

    // pgvector's `<=>` is cosine distance in [0, 2]; `1 - (a <=> b)`
    // is cosine similarity. We further map cos similarity in
    // [-1, 1] → [0, 1] via `(s + 1) / 2` to match MemoryDriver so
    // scores are comparable across drivers.
    const params: unknown[] = [collection, `[${vector.join(',')}]`]
    const where: string[] = [`"collection" = $1`]

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        params.push(JSON.stringify(value))
        where.push(
          `"metadata" @> jsonb_build_object('${escapeJsonbKey(key)}', $${params.length}::jsonb)`,
        )
      }
    }

    let sql = `
      SELECT "id", "source_id", "content", "metadata",
             ((1 - ("embedding" <=> $2::vector)) + 1) / 2 AS score
      FROM "${this.table}"
      WHERE ${where.join(' AND ')}
    `
    if (threshold !== undefined) {
      params.push(threshold)
      sql += ` AND ((1 - ("embedding" <=> $2::vector)) + 1) / 2 >= $${params.length}`
    }
    params.push(topK)
    sql += ` ORDER BY "embedding" <=> $2::vector LIMIT $${params.length}`

    let rows: Array<{
      id: string
      source_id: string | null
      content: string
      metadata: Record<string, unknown> | string
      score: number | string
    }>
    try {
      rows = await this.exec().query(sql, params)
    } catch (cause) {
      throw new VectorQueryError(`pgvector query failed for collection "${collection}".`, {
        context: { collection, table: this.table },
        cause,
      })
    }

    const matches: VectorMatch[] = rows.map((r) => ({
      id: r.id,
      content: r.content,
      score: typeof r.score === 'string' ? Number.parseFloat(r.score) : r.score,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
      sourceId: r.source_id,
    }))
    return { matches, processingTimeMs: performance.now() - start }
  }
}

/**
 * Escape a JSONB object key for embedding in an SQL string. Keys
 * are app-supplied so we sanitize defensively — backslash-escape
 * single quotes; refuse keys with NUL bytes.
 */
function escapeJsonbKey(key: string): string {
  if (key.includes('\0')) {
    throw new VectorQueryError(`pgvector filter key contains NUL byte: ${JSON.stringify(key)}`)
  }
  return key.replace(/'/g, "''")
}
