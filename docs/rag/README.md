# @strav/rag

Retrieval-augmented generation for Strav 1.0. One fluent surface (`rag.ingest`, `rag.retrieve`, `rag.createCollection`) that routes into an in-memory store, pgvector, or a future adapter. Apps that want to switch vector backends change one config entry, not their codebase. Embeddings route through `@strav/brain`; persistence routes through `@strav/database`.

```ts
import { RagManager } from '@strav/rag'

const rag = container.resolve(RagManager)

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

// Route to a named store
const local = await rag.store('inMemoryCache').query(/* ... */)
```

## What ships in v1

| Surface | Where |
|---|---|
| Core abstraction: manager, normalized types, errors, chunkers, `ragVectorSchema`, `applyRagVectorMigration` | `@strav/rag` |
| Memory driver — in-process Map<collection, document[]> with cosine similarity. For tests + dev. | `@strav/rag` (built in) |
| Pgvector driver — Postgres + the `pgvector` extension. HNSW index, RLS-scoped per tenant, default `rag_vector` table. | `@strav/rag` (built in) |
| `retrievable()` Repository mixin + `RetrievableRegistry` | `@strav/rag` |
| `rag:flush` + `rag:list` + `rag:reindex` console commands | `@strav/rag` |
| Re-ranking — `Reranker` interface + `KeywordReranker` + `MMRReranker` | `@strav/rag` |
| Qdrant / Pinecone / Weaviate drivers | **deferred** — apps register custom drivers via `rag.extend(name, factory)` (see `guides/custom-drivers.md`). |
| Embedding cache | **deferred** — apps wrap `brain.embed` with `@strav/cache` for now. |

## Install

```bash
bun add @strav/rag
```

The memory and pgvector drivers ship inside the same package — no separate install. The pgvector driver requires the Postgres `pgvector` extension (`CREATE EXTENSION vector;` once per database) and `@strav/database` registered.

## Configure

```ts
// config/rag.ts
export default {
  default: 'articles',
  prefix: env('APP_NAME'), // optional collection-name prefix for namespacing
  embedding: {
    provider: 'openai',                  // brain provider key
    model: 'text-embedding-3-small',
    dimension: 1536,                     // must match the model
  },
  chunking: {
    strategy: 'recursive',               // 'fixed' or 'recursive'
    chunkSize: 500,
    overlap: 50,
  },
  stores: {
    articles: {
      driver: 'pgvector',
      table: 'rag_vector',               // optional; default is 'rag_vector'
    },
    inMemoryCache: {
      driver: 'memory',
    },
  },
}
```

```ts
// bootstrap/providers.ts
import { BrainProvider } from '@strav/brain'
import { DatabaseProvider } from '@strav/database'
import { RagProvider } from '@strav/rag'

export default [
  ConfigProvider,
  LoggerProvider,
  DatabaseProvider,    // required if any store uses `driver: 'pgvector'`
  BrainProvider,       // required — rag uses brain.embed for vectorization
  RagProvider,         // boots after both
  // ...
]
```

`RagProvider` eager-resolves `RagManager` at boot — config errors surface at startup, not on first ingest.

## Database migration

```ts
import { applyRagVectorMigration } from '@strav/rag'

export const migration: Migration = {
  name: '20260601000000_create_rag_vector',
  async up(db) {
    await applyRagVectorMigration(db, {
      registry,
      dimension: 1536,                   // must match config.rag.embedding.dimension
      table: 'rag_vector',               // optional; matches config.rag.stores.<name>.table
      hnswM: 16,                         // optional HNSW knob
      hnswEfConstruction: 64,            // optional HNSW knob
    })
  },
}
```

Creates one tenanted table with a `vector(N)` column and an HNSW index. RLS-scoped per tenant by default — multi-tenant apps get isolation for free.

Apps that ship multiple `pgvector` stores with different dimensions need a migration per dimension and one table per store; pass `table` to keep them distinct.

## Custom stores via `extend()`

```ts
rag.extend('qdrant', (config) => new QdrantDriver({
  url: env('QDRANT_URL'),
  apiKey: env('QDRANT_API_KEY'),
  collection: config.collection as string,
}))
```

Once registered, any `stores.<name>.driver: 'qdrant'` resolves through the factory. The driver implements `VectorStore` (six methods: `createCollection`, `dropCollection`, `upsert`, `query`, `delete`, `count`). See `guides/custom-drivers.md` for the full walk-through.

For one-off wiring (tests, scripts), use `rag.useStore(name, store)` to register an already-built instance directly.

## Re-ranking

Vector similarity is a strong baseline but loses information (keyword overlap, diversity, recency, second-stage scores). `RetrieveOptions.rerank` reorders the matches after the vector query; `rerankPool` widens the candidate pool before re-ranking so the reranker has room to reorder.

```ts
import { KeywordReranker } from '@strav/rag'

const { matches } = await rag.retrieve(query, {
  topK: 5,
  rerankPool: 25,                                       // fetch wider
  rerank: new KeywordReranker({ weight: 0.3 }),         // blend cosine + keyword overlap
})
```

Two strategies ship:

- **`KeywordReranker`** — `score = (1 - weight) * similarity + weight * tokenOverlap`. Useful when the embedder smooths over short, jargon-heavy queries (SKUs, error codes, acronyms).
- **`MMRReranker`** — Maximal Marginal Relevance for diversity. Penalizes near-duplicates from the same source. Takes an `embed(text)` callback (wire from `BrainManager.embed`); `lambda` blends relevance (1) vs. diversity (0), default `0.5`.

Custom rerankers implement the `Reranker` interface — a single async `rerank(query, matches) => RetrievedDocument[]`. Drop in a cross-encoder, a Cohere Rerank call, an LLM-as-judge pass, etc. without touching framework code.

## Errors apps catch

- **`CollectionNotFoundError`** — query against an unknown collection.
- **`VectorQueryError`** — driver-level failure (pg connection lost, etc.).
- **`EmbeddingError`** — brain embed call threw. The original exception is in `.cause`.
- **`RagError`** — base + everything else (config missing, unknown driver).

## When NOT to use rag

- **One-shot search.** If your query against a fixed corpus is "find docs that contain string X", reach for `@strav/search` (FTS) instead. RAG shines when semantic similarity matters, not when literal-token containment is the answer.
- **Very small corpora.** Under a few hundred chunks, a direct LLM call with the full content in the prompt is often cheaper and more accurate than chunk-and-retrieve.
- **Frequently changing content.** If the source rewrites every minute, re-indexing churns more than it helps. Cache the LLM call instead.

## Navigation

- [guides/getting-started.md](./guides/getting-started.md) — install, configure, run the first ingest.
- [guides/retrievable.md](./guides/retrievable.md) — `retrievable()` repository mixin: auto-vectorize, source-row resolution, re-indexing a corpus.
- [guides/migration.md](./guides/migration.md) — the pgvector migration template; HNSW knobs; dimension mismatches.
- [guides/multitenancy.md](./guides/multitenancy.md) — RLS isolation across tenants; the `withTenant(...)` pattern.
- [guides/custom-drivers.md](./guides/custom-drivers.md) — implement `VectorStore` against Qdrant, Pinecone, Weaviate, etc.
- [guides/cli.md](./guides/cli.md) — `rag:flush` + `rag:list` + `rag:reindex` console commands.
