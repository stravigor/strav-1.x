/**
 * `@strav/rag` types — the data shapes apps see when reading and
 * writing vectors and when running retrieval.
 *
 * Three concept clusters:
 *
 *   - **Vector docs + queries** — the storage layer. A
 *     `VectorDocument` is one indexed unit (a chunk of source
 *     content, its embedding, and free-form metadata).
 *     `query()` returns `VectorMatch[]` ranked by similarity.
 *
 *   - **Retrieval pipeline** — `RetrieveOptions` /
 *     `RetrieveResult`. Apps call `rag.retrieve(query, ...)`,
 *     the manager embeds the query through `@strav/brain`,
 *     queries the active store, and returns matches with
 *     normalized similarity scores.
 *
 *   - **Chunking** — `Chunk`, `Chunker`. The chunker takes raw
 *     content and produces overlapping segments suitable for
 *     embedding. Two strategies ship: `fixed` (mechanical N-char
 *     windows with overlap) and `recursive` (paragraph-aware,
 *     better for prose).
 */

// ─── Vector documents + queries ──────────────────────────────────────────

/**
 * One indexed unit. `id` is provider-assigned (ULID by default);
 * `sourceId` is the optional app-defined pointer back to the row
 * the chunk came from (e.g., `article_id`) — `deleteBySource`
 * removes every chunk for one source in a single call.
 */
export interface VectorDocument {
  id?: string
  sourceId?: string | null
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
}

export interface QueryOptions {
  /** Top-K matches to return. Default `5`. */
  topK?: number
  /** Minimum similarity threshold (0–1). Matches below this are filtered out. */
  threshold?: number
  /** Metadata filter — flat key/value AND. Driver-specific operators are NOT supported in V1. */
  filter?: Record<string, unknown>
}

export interface QueryResult {
  matches: VectorMatch[]
  /** Time the underlying store took to compute the query, in ms. */
  processingTimeMs: number
}

export interface VectorMatch {
  id: string
  content: string
  /** Similarity score in [0, 1]. 1.0 = identical embeddings, 0 = orthogonal. */
  score: number
  metadata: Record<string, unknown>
  sourceId?: string | null
}

// ─── Retrieval pipeline ─────────────────────────────────────────────────

export interface RetrieveOptions {
  /** Override the collection. Defaults to the manager's default. */
  collection?: string
  /** Top-K matches. Default `5`. */
  topK?: number
  /** Minimum similarity threshold. */
  threshold?: number
  /** Metadata filter — flat key/value AND. */
  filter?: Record<string, unknown>
  /** Override the store. Defaults to the manager's default store. */
  store?: string
  /** Override the embedding model used to encode the query. */
  embedModel?: string
  /** Override the brain provider used for embedding. */
  embedProvider?: string
}

export interface RetrieveResult {
  matches: RetrievedDocument[]
  query: string
  processingTimeMs: number
}

export interface RetrievedDocument {
  id: string
  content: string
  /** Same as `VectorMatch.score` — kept as a separate field so future re-ranking can diverge `score` from raw `similarity`. */
  score: number
  similarity: number
  metadata: Record<string, unknown>
  sourceId?: string | null
}

// ─── Chunking ────────────────────────────────────────────────────────────

export interface Chunk {
  content: string
  /** 0-based ordinal within the source. */
  index: number
  /** Character offset of the chunk's first character in the source. */
  startOffset: number
  /** Character offset one past the chunk's last character. */
  endOffset: number
}

export interface Chunker {
  chunk(content: string): Chunk[]
}

// ─── Configuration ──────────────────────────────────────────────────────

/**
 * `config.rag` shape. Apps that don't configure rag get a sensible
 * default (memory driver, OpenAI text-embedding-3-small, recursive
 * chunking) — see `RagProvider.boot()` for the defaults.
 */
export interface RagConfig {
  /** Default store name — must be a key in `stores`. */
  default: string
  /** Optional collection-name prefix. Used to namespace per-app or per-tenant. */
  prefix?: string
  embedding: EmbeddingConfig
  chunking: ChunkingConfig
  stores: Record<string, StoreConfig>
}

export interface EmbeddingConfig {
  /** `@strav/brain` provider key (e.g., `'openai'`, `'gemini'`, `'ollama'`). */
  provider: string
  /** Model identifier — passed to `brain.embed(..., { model })`. */
  model: string
  /** Vector dimension. Must match the chosen model. */
  dimension: number
}

export interface ChunkingConfig {
  /** `'fixed'` or `'recursive'`. Custom strategies aren't pluggable in V1. */
  strategy: 'fixed' | 'recursive'
  chunkSize: number
  overlap: number
  /** Custom separators for the recursive strategy. Defaults to `['\n\n', '\n', '. ', ' ']`. */
  separators?: readonly string[]
}

export interface StoreConfig {
  /** `'memory'` or `'pgvector'`; custom drivers register via `rag.extend(name, factory)`. */
  driver: string
  /** Pgvector: explicit table name override. Default `'rag_vector'`. */
  table?: string
  /** Free-form fields driver-specific (e.g., HNSW tuning for pgvector). */
  [key: string]: unknown
}
