// Public API of `@strav/rag`.
//
// Shipped:
//   - Vector store abstraction + Memory & Pgvector drivers.
//   - Fixed-size + recursive chunkers.
//   - `RagManager` + `RagProvider` service wiring.
//   - `retrievable()` repository mixin + `RetrievableRegistry`.
//   - CLI: `rag:list`, `rag:flush`, `rag:reindex {name|--all}`.
//   - Re-ranking — `Reranker` interface + `KeywordReranker` +
//     `MMRReranker` + `RetrieveOptions.rerank` / `rerankPool`.
// Composes with `@strav/brain` for embeddings and `@strav/database`
// for pgvector persistence + multitenancy.

export { createChunker } from './chunking/chunker.ts'
export { FixedSizeChunker } from './chunking/fixed_size_chunker.ts'
export { RecursiveChunker } from './chunking/recursive_chunker.ts'
export {
  RagConsoleProvider,
  RagFlush,
  RagList,
  RagReindex,
} from './console/index.ts'
export { MemoryDriver } from './drivers/memory/memory_driver.ts'
export {
  PgvectorDriver,
  type PgvectorDriverOptions,
} from './drivers/pgvector/pgvector_driver.ts'
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
export {
  KeywordReranker,
  type KeywordRerankerOptions,
  MMRReranker,
  type MMRRerankerOptions,
  type Reranker,
} from './rerankers/index.ts'
export { retrievable } from './retrievable.ts'
export {
  RetrievableRegistry,
  type RetrievableTarget,
} from './retrievable_registry.ts'
export type {
  Chunk,
  Chunker,
  ChunkingConfig,
  EmbeddingConfig,
  QueryOptions,
  QueryResult,
  RagConfig,
  RetrievedDocument,
  RetrieveOptions,
  RetrieveResult,
  StoreConfig,
  VectorDocument,
  VectorMatch,
} from './types.ts'
export type { VectorStore } from './vector_store.ts'
export {
  type ApplyRagVectorMigrationOptions,
  applyRagVectorMigration,
} from './vectors/apply_rag_vector_migration.ts'
export { ragVectorSchema } from './vectors/rag_vector_schema.ts'
