/**
 * `MemoryDriver` — in-process `VectorStore` backed by `Map`s.
 *
 * Two real use cases:
 *
 *   1. **Tests.** Apps test their retrieval logic without booting
 *      Postgres + pgvector. Reset between tests via
 *      `new MemoryDriver()`.
 *   2. **Local dev.** Faster boot, no migration to run. Apps
 *      flip to `pgvector` for production via
 *      `config.rag.default`.
 *
 * Out of scope:
 *
 *   - **Multitenancy.** No tenant scoping; everything in the
 *     same Map. Apps that test tenant isolation use pgvector
 *     against a real Postgres.
 *   - **Persistence.** Vectors die with the process.
 *   - **Performance.** O(N) scan per query — fine for thousands
 *     of vectors, painful past tens of thousands.
 */

import { CollectionNotFoundError } from '../../rag_error.ts'
import type {
  QueryOptions,
  QueryResult,
  VectorDocument,
  VectorMatch,
} from '../../types.ts'
import type { VectorStore } from '../../vector_store.ts'

interface StoredDoc {
  id: string
  sourceId: string | null
  content: string
  embedding: readonly number[]
  metadata: Record<string, unknown>
}

export class MemoryDriver implements VectorStore {
  readonly name = 'memory'

  private readonly collections = new Map<string, Map<string, StoredDoc>>()
  private readonly dimensions = new Map<string, number>()

  async createCollection(collection: string, dimension: number): Promise<void> {
    if (!this.collections.has(collection)) {
      this.collections.set(collection, new Map())
      this.dimensions.set(collection, dimension)
    }
  }

  async deleteCollection(collection: string): Promise<void> {
    this.collections.delete(collection)
    this.dimensions.delete(collection)
  }

  async upsert(
    collection: string,
    documents: readonly VectorDocument[],
  ): Promise<void> {
    const bucket = this.requireBucket(collection)
    for (const doc of documents) {
      const id = doc.id ?? crypto.randomUUID()
      bucket.set(id, {
        id,
        sourceId: doc.sourceId ?? null,
        content: doc.content,
        embedding: [...doc.embedding],
        metadata: doc.metadata ?? {},
      })
    }
  }

  async delete(collection: string, ids: readonly string[]): Promise<void> {
    const bucket = this.requireBucket(collection)
    for (const id of ids) bucket.delete(id)
  }

  async deleteBySource(collection: string, sourceId: string): Promise<void> {
    const bucket = this.requireBucket(collection)
    for (const [id, doc] of bucket) {
      if (doc.sourceId === sourceId) bucket.delete(id)
    }
  }

  async flush(collection: string): Promise<void> {
    const bucket = this.collections.get(collection)
    if (bucket) bucket.clear()
  }

  async query(
    collection: string,
    vector: readonly number[],
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const start = performance.now()
    const bucket = this.requireBucket(collection)
    const topK = options.topK ?? 5
    const threshold = options.threshold ?? 0
    const filter = options.filter

    const scored: VectorMatch[] = []
    for (const doc of bucket.values()) {
      if (filter && !matchesFilter(doc.metadata, filter)) continue
      const score = cosineSimilarity(vector, doc.embedding)
      if (score < threshold) continue
      scored.push({
        id: doc.id,
        content: doc.content,
        score,
        metadata: doc.metadata,
        sourceId: doc.sourceId,
      })
    }

    scored.sort((a, b) => b.score - a.score)
    const matches = scored.slice(0, topK)
    return { matches, processingTimeMs: performance.now() - start }
  }

  private requireBucket(collection: string): Map<string, StoredDoc> {
    const bucket = this.collections.get(collection)
    if (!bucket) throw new CollectionNotFoundError(collection, this.name)
    return bucket
  }
}

/**
 * Cosine similarity in [-1, 1] mapped to [0, 1] by `(s + 1) / 2`.
 * Matches pgvector's `1 - (a <=> b)` semantic so MemoryDriver and
 * PgvectorDriver scores compare like-for-like.
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  return (cos + 1) / 2
}

/** Flat AND match — every key in `filter` must equal the corresponding `metadata` key. */
function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(filter)) {
    if (metadata[key] !== filter[key]) return false
  }
  return true
}
