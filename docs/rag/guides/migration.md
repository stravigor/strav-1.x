# Migration + DDL

The framework's schema system can't model `pgvector`'s `vector(N)` column type, so `@strav/rag` ships **two pieces** that work together:

1. **`ragVectorSchema`** — a `defineSchema` declaration for the standard columns + tenancy. Apps register it with `SchemaRegistry` like every other framework schema.
2. **`applyRagVectorMigration(db, opts)`** — a helper that:
   - Enables the `vector` extension
   - Emits `CREATE TABLE` for `ragVectorSchema` (gets you tenant_id + RLS for free)
   - Adds the `embedding vector(N)` column
   - Creates an HNSW index on cosine ops
   - Adds secondary indexes on `collection` and `source_id`

## Template

```ts
// database/migrations/20260601000000_create_rag_vector.ts
import { emitDropTable, type Migration } from '@strav/database'
import { applyRagVectorMigration, ragVectorSchema } from '@strav/rag'

export const migration: Migration = {
  name: '20260601000000_create_rag_vector',
  async up(db, { registry }) {
    await applyRagVectorMigration(db, {
      dimension: 1536,           // match config.rag.embedding.dimension
      registry,
      // Optional HNSW tuning — defaults are sensible.
      // hnswM: 16,
      // hnswEfConstruction: 64,
    })
  },
  async down(db) {
    await db.execute(emitDropTable(ragVectorSchema.name).sql)
  },
}
```

## Dimension is load-bearing

The `dimension` argument MUST match the embedding model your app uses:

| Model | Dimension |
|---|---|
| OpenAI `text-embedding-3-small` | 1536 |
| OpenAI `text-embedding-3-large` | 3072 |
| OpenAI `text-embedding-ada-002` (legacy) | 1536 |
| Gemini `text-embedding-004` | 768 |
| Local Ollama `nomic-embed-text` | 768 |
| Local Ollama `mxbai-embed-large` | 1024 |

A mismatch surfaces at INSERT time as a pgvector cast error. Apps that want to switch dimensions later create a new table (or use a `table` override on `applyRagVectorMigration`) and migrate vectors over — pgvector doesn't allow `ALTER TYPE` between `vector(M)` and `vector(N)` non-destructively.

## HNSW knobs

| Knob | Default | Effect |
|---|---|---|
| `m` | 16 | Graph degree. Higher = better recall, slower builds, more memory. |
| `ef_construction` | 64 | Construction-time search width. Higher = better recall, slower builds. |

Tune `m` upward (32 / 48) for corpora where recall matters more than ingest speed. Leave `ef_construction` at the default unless your dataset has known difficult clusters.

Query-time `ef_search` is a session GUC — apps set it per-call if needed:

```sql
SET LOCAL hnsw.ef_search = 200;
```

The framework doesn't expose this yet; apps drop down to raw SQL via `db.execute(...)` when they need it.

## Indexes the migration ships

```sql
CREATE INDEX idx_rag_vector_embedding_hnsw
  ON rag_vector USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_rag_vector_collection
  ON rag_vector (collection);

CREATE INDEX idx_rag_vector_source_id
  ON rag_vector (source_id) WHERE source_id IS NOT NULL;
```

The `embedding_hnsw` index is the load-bearing one. The other two help the standard delete-by-collection / delete-by-source paths.

For very large per-collection corpora (millions of vectors per collection) consider per-collection partial HNSW indexes:

```sql
CREATE INDEX idx_rag_vector_embedding_articles
  ON rag_vector USING hnsw (embedding vector_cosine_ops)
  WHERE collection = 'articles';
```

This narrows the index to one collection, improving recall + latency at the cost of disk and build time per collection.

## Custom table name

Apps that need multiple vector tables (e.g., one per dimension, or one per high-volume collection) pass `table`:

```ts
await applyRagVectorMigration(db, {
  dimension: 768,
  registry,
  table: 'rag_vector_768',
})
```

The driver also accepts `table` in its config:

```ts
{
  stores: {
    embeds_768: { driver: 'pgvector', table: 'rag_vector_768' },
  },
}
```

You also need to declare a schema variant under the override name and register it. The simplest path: copy `ragVectorSchema`'s body and rename — schemas are immutable, so there's no way to "rename" a single instance.

## Down migration

`emitDropTable(ragVectorSchema.name)` drops the table. The `vector` extension itself stays — apps that have other pgvector consumers don't want it disabled.
