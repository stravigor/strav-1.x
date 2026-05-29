/**
 * `RagManager` — the facade apps use for RAG workflows.
 *
 * Three concept clusters:
 *
 *   - **Stores.** Apps register vector stores in
 *     `config.rag.stores`; the manager constructs them lazily on
 *     first `store(name)` call. Custom drivers register via
 *     `manager.extend(name, factory)`.
 *
 *   - **Ingest.** `manager.ingest(collection, content, opts?)`
 *     chunks → embeds → upserts. Returns the vector ids it
 *     wrote. Apps that already have chunks bypass the chunker
 *     by passing `IngestOptions.chunks`.
 *
 *   - **Retrieve.** `manager.retrieve(query, opts?)` embeds the
 *     query, runs the store's similarity search, and returns
 *     ranked matches. `topK` / `threshold` / `filter` pass
 *     through.
 *
 * Multitenancy: invisible. The pgvector driver relies on RLS via
 * `app.tenant_id` session settings, so apps that wrap calls in
 * `tenants.withTenant(...)` get per-tenant isolation for free.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase value import for the container path that wires PgvectorDriver.
import { PostgresDatabase } from '@strav/database'
// biome-ignore lint/style/useImportType: BrainManager value import for @inject() param-type metadata.
import { BrainManager } from '@strav/brain'
// biome-ignore lint/style/useImportType: Application value import for the container handle.
import { Application, inject } from '@strav/kernel'
import { createChunker } from './chunking/chunker.ts'
import { MemoryDriver } from './drivers/memory_driver.ts'
import { PgvectorDriver } from './drivers/pgvector_driver.ts'
import { EmbeddingError, RagError } from './rag_error.ts'
import type {
  ChunkingConfig,
  Chunk,
  Chunker,
  RagConfig,
  RetrieveOptions,
  RetrieveResult,
  RetrievedDocument,
  StoreConfig,
  VectorDocument,
} from './types.ts'
import type { VectorStore } from './vector_store.ts'

export interface IngestOptions {
  /**
   * Override the store. Defaults to the manager's default store.
   */
  store?: string
  /** App-defined pointer back to the source row this content came from. */
  sourceId?: string
  /** Metadata attached to every chunk. Combined with per-chunk metadata if `chunks` is supplied. */
  metadata?: Record<string, unknown>
  /** Override chunking strategy + size for this call. */
  chunking?: Partial<ChunkingConfig>
  /**
   * Pre-chunked content — skips the chunker entirely. The chunker
   * helpers (`startOffset`, `endOffset`, `index`) carry through
   * as metadata.
   */
  chunks?: readonly Chunk[]
  /**
   * Optional per-chunk sanitizer applied AFTER chunking, BEFORE
   * embedding. Return `null` to drop the chunk; otherwise return
   * the (possibly modified) text. Use to scrub PII / secrets /
   * prompt-injection markers from untrusted source content.
   */
  sanitize?(chunk: { content: string; index: number }): string | null | Promise<string | null>
  /** Override the brain provider used for the embedding call. */
  embedProvider?: string
  /** Override the embedding model. */
  embedModel?: string
}

export interface RagManagerOptions {
  config: RagConfig
  brain: BrainManager
  /** Optional — required only if pgvector stores are configured. */
  db?: PostgresDatabase
}

/** Factory for custom drivers — apps register via `manager.extend(name, factory)`. */
export type StoreFactory = (config: StoreConfig) => VectorStore

@inject()
export class RagManager {
  readonly config: RagConfig
  private readonly brain: BrainManager
  private readonly db: PostgresDatabase | undefined
  private readonly stores = new Map<string, VectorStore>()
  private readonly extensions = new Map<string, StoreFactory>()

  constructor(options: RagManagerOptions) {
    if (!options.config.stores[options.config.default]) {
      throw new RagError(
        `RagManager: default store "${options.config.default}" is not configured.`,
        {
          context: {
            default: options.config.default,
            available: Object.keys(options.config.stores),
          },
        },
      )
    }
    this.config = options.config
    this.brain = options.brain
    this.db = options.db
  }

  // ─── Store management ─────────────────────────────────────────────────

  /**
   * Resolve a vector store by name (or the default when omitted).
   * Stores are constructed lazily on first use + memoized.
   */
  store(name?: string): VectorStore {
    const key = name ?? this.config.default
    const cached = this.stores.get(key)
    if (cached) return cached
    const cfg = this.config.stores[key]
    if (!cfg) {
      throw new RagError(`RagManager: store "${key}" is not configured.`, {
        context: { requested: key, available: Object.keys(this.config.stores) },
      })
    }
    const store = this.createStore(cfg)
    this.stores.set(key, store)
    return store
  }

  /** Register a custom driver. Subsequent `store(...)` calls can resolve `driver: <name>`. */
  extend(name: string, factory: StoreFactory): void {
    this.extensions.set(name, factory)
  }

  /** Hand-wire a store instance under a name (tests / one-off drivers). */
  useStore(name: string, store: VectorStore): void {
    this.stores.set(name, store)
  }

  /**
   * Compose the configured prefix with `name` — apps that want to
   * namespace collections (per-tenant, per-app) set `config.rag.prefix`
   * and call `manager.collectionName(...)` to resolve at runtime.
   */
  collectionName(name: string): string {
    return this.config.prefix ? `${this.config.prefix}${name}` : name
  }

  // ─── Ingest ───────────────────────────────────────────────────────────

  /**
   * Chunk → embed → upsert. Returns the vector ids it wrote. The
   * caller-supplied `collection` is composed with the configured
   * `prefix` before hitting the store.
   */
  async ingest(
    collection: string,
    content: string,
    options: IngestOptions = {},
  ): Promise<string[]> {
    const fullCollection = this.collectionName(collection)
    const chunkerConfig: ChunkingConfig = {
      strategy: options.chunking?.strategy ?? this.config.chunking.strategy,
      chunkSize: options.chunking?.chunkSize ?? this.config.chunking.chunkSize,
      overlap: options.chunking?.overlap ?? this.config.chunking.overlap,
      ...(options.chunking?.separators ?? this.config.chunking.separators
        ? { separators: options.chunking?.separators ?? this.config.chunking.separators }
        : {}),
    }

    let chunks: Chunk[] = options.chunks
      ? [...options.chunks]
      : this.chunker(chunkerConfig).chunk(content)
    if (chunks.length === 0) return []

    if (options.sanitize) {
      const filtered: Chunk[] = []
      for (const chunk of chunks) {
        const next = await options.sanitize({ content: chunk.content, index: chunk.index })
        if (next === null) continue
        filtered.push({ ...chunk, content: next })
      }
      chunks = filtered
      if (chunks.length === 0) return []
    }

    const texts = chunks.map((c) => c.content)
    let embeddings: number[][]
    try {
      const result = await this.brain.embed(texts, {
        provider: options.embedProvider ?? this.config.embedding.provider,
        model: options.embedModel ?? this.config.embedding.model,
      })
      embeddings = result.embeddings as number[][]
    } catch (cause) {
      throw new EmbeddingError(
        `RagManager.ingest: embedding ${texts.length} chunks failed.`,
        { context: { collection: fullCollection }, cause },
      )
    }

    const baseId = crypto.randomUUID()
    const documents: VectorDocument[] = chunks.map((chunk, i) => ({
      id: `${baseId}_${i}`,
      ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
      content: chunk.content,
      embedding: embeddings[i]!,
      metadata: {
        ...(options.metadata ?? {}),
        chunkIndex: chunk.index,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      },
    }))

    await this.store(options.store).upsert(fullCollection, documents)
    return documents.map((d) => d.id as string)
  }

  // ─── Retrieve ─────────────────────────────────────────────────────────

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrieveResult> {
    const fullCollection = this.collectionName(
      options.collection ?? this.config.default,
    )
    const start = performance.now()

    let embedding: number[]
    try {
      const result = await this.brain.embed([query], {
        provider: options.embedProvider ?? this.config.embedding.provider,
        model: options.embedModel ?? this.config.embedding.model,
      })
      embedding = result.embeddings[0] as number[]
    } catch (cause) {
      throw new EmbeddingError(
        `RagManager.retrieve: embedding query failed.`,
        { context: { collection: fullCollection }, cause },
      )
    }

    const queryOpts: { topK?: number; threshold?: number; filter?: Record<string, unknown> } = {}
    if (options.topK !== undefined) queryOpts.topK = options.topK
    if (options.threshold !== undefined) queryOpts.threshold = options.threshold
    if (options.filter !== undefined) queryOpts.filter = options.filter

    const result = await this.store(options.store).query(
      fullCollection,
      embedding,
      queryOpts,
    )

    const matches: RetrievedDocument[] = result.matches.map((m) => ({
      id: m.id,
      content: m.content,
      score: m.score,
      similarity: m.score,
      metadata: m.metadata,
      ...(m.sourceId !== undefined ? { sourceId: m.sourceId } : {}),
    }))

    return {
      query,
      matches,
      processingTimeMs: performance.now() - start,
    }
  }

  /**
   * Create a collection on the active (or named) store. For
   * pgvector this is a no-op — every collection lives in the
   * same table. For MemoryDriver this allocates the bucket.
   * Apps call it once at boot or before the first ingest of a
   * new collection name.
   */
  async createCollection(
    collection: string,
    options: { store?: string; dimension?: number } = {},
  ): Promise<void> {
    const fullCollection = this.collectionName(collection)
    const dimension = options.dimension ?? this.config.embedding.dimension
    await this.store(options.store).createCollection(fullCollection, dimension)
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private chunker(config: ChunkingConfig): Chunker {
    return createChunker(config)
  }

  private createStore(config: StoreConfig): VectorStore {
    const ext = this.extensions.get(config.driver)
    if (ext) return ext(config)
    switch (config.driver) {
      case 'memory':
        return new MemoryDriver()
      case 'pgvector':
        if (!this.db) {
          throw new RagError(
            'RagManager: pgvector driver requires a PostgresDatabase. Register DatabaseProvider before RagProvider, or pass `db` to the manager constructor.',
          )
        }
        return PgvectorDriver.fromConfig(this.db, config)
      default:
        throw new RagError(
          `RagManager: unknown driver "${config.driver}". Register it via \`manager.extend(...)\`.`,
          { context: { driver: config.driver } },
        )
    }
  }
}

/** Public alias for the container-resolution helper apps occasionally pass around. */
export type RagManagerResolver = (app: Application) => RagManager
