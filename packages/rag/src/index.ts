// Public API of `@strav/rag`.
//
// V1: vector store abstraction + memory & pgvector drivers +
// fixed-size & recursive chunkers + RagManager + RagProvider.
// Composes with `@strav/brain` for embeddings and `@strav/database`
// for pgvector persistence + multitenancy.
//
// Deferred to follow-up slices: `retrievable()` repository mixin,
// CLI commands (`rag:reindex`, `rag:flush`), re-ranking strategies.

export { createChunker } from './chunking/chunker.ts'
export { FixedSizeChunker } from './chunking/fixed_size_chunker.ts'
export { RecursiveChunker } from './chunking/recursive_chunker.ts'
export { MemoryDriver } from './drivers/memory_driver.ts'
export {
  PgvectorDriver,
  type PgvectorDriverOptions,
} from './drivers/pgvector_driver.ts'
export {
  applyRagVectorMigration,
  type ApplyRagVectorMigrationOptions,
} from './migrations.ts'
export {
  CollectionNotFoundError,
  EmbeddingError,
  RagError,
  VectorQueryError,
} from './rag_error.ts'
export {
  type IngestOptions,
  RagManager,
  type RagManagerOptions,
  type StoreFactory,
} from './rag_manager.ts'
export { RagProvider } from './rag_provider.ts'
export { ragVectorSchema } from './rag_vector_schema.ts'
export type {
  Chunk,
  Chunker,
  ChunkingConfig,
  EmbeddingConfig,
  QueryOptions,
  QueryResult,
  RagConfig,
  RetrieveOptions,
  RetrieveResult,
  RetrievedDocument,
  StoreConfig,
  VectorDocument,
  VectorMatch,
} from './types.ts'
export type { VectorStore } from './vector_store.ts'
