# `@strav/rag`

Retrieval-augmented generation for Strav 1.0. Composes `@strav/brain` for embeddings and `@strav/database` for persistence — apps drop this in to vectorize source content, run similarity search, and feed the top-K back to a brain call.

```ts
import { RagManager } from '@strav/rag'

const rag = app.resolve(RagManager)

// Index a source document
await rag.createCollection('articles')
const ids = await rag.ingest('articles', article.body, {
  sourceId: article.id,
  metadata: { author: article.author },
})

// Retrieve relevant chunks for a user query
const { matches } = await rag.retrieve('How does compaction work?', {
  collection: 'articles',
  topK: 5,
})

const context = matches.map((m) => m.content).join('\n\n')
const { text } = await brain.chat(`Context:\n${context}\n\nQuestion: ${userInput}`)
```

## What ships

- **`RagManager`** — facade for the ingest + retrieve workflows.
- **`VectorStore`** interface + two drivers:
  - **`MemoryDriver`** — in-process, for tests + dev.
  - **`PgvectorDriver`** — Postgres + the `pgvector` extension. HNSW index, RLS-scoped per tenant.
- **Chunkers** — `FixedSizeChunker` + `RecursiveChunker` (paragraph-aware).
- **`ragVectorSchema`** + `applyRagVectorMigration` — the recommended `rag_vector` table layout and a migration helper that adds the `vector(N)` column + HNSW index.
- **`RagProvider`** — service provider that wires `RagManager` into the container.

## Status

V1 — pgvector / memory drivers, two chunkers, the manager + provider, tenanted vector table. Deferred to follow-up slices: the `retrievable()` repository mixin, CLI commands (`rag:reindex`, `rag:flush`), re-ranking strategies.

## Guides

- [`guides/getting-started.md`](./guides/getting-started.md) — install, configure, run the first ingest.
- [`guides/migration.md`](./guides/migration.md) — the pgvector migration template; HNSW knobs; dimensions.
- [`guides/multitenancy.md`](./guides/multitenancy.md) — RLS isolation across tenants; the `withTenant(...)` pattern.
- [`guides/custom-drivers.md`](./guides/custom-drivers.md) — implement `VectorStore` against Qdrant, Pinecone, etc.

## When NOT to use rag

- **One-shot search.** If your query against a fixed corpus is "find docs that contain string X", reach for `@strav/search` (FTS) instead. RAG shines when semantic similarity matters, not when literal-token containment is the answer.
- **Very small corpora.** Under a few hundred chunks, a direct LLM call with the full content in the prompt is often cheaper and more accurate than chunk-and-retrieve.
- **Frequently changing content.** If the source rewrites every minute, re-indexing churns more than it helps. Cache the LLM call instead.
