/**
 * `ragVectorSchema` — the framework-known shape of the vectors
 * table. Carries every column EXCEPT `embedding`, which lives
 * outside the framework schema system because pgvector's
 * `vector(N)` type isn't expressible via `defineSchema`. The
 * `applyRagVectorMigration` helper attaches the embedding column
 * + HNSW index in the migration step.
 *
 * Columns the framework manages:
 *
 *   - `id`         ULID primary key.
 *   - `tenant_id`  Auto-injected by `tenanted: true`. RLS policies
 *                  scope reads + writes by
 *                  `current_setting('app.tenant_id')` so apps that
 *                  wrap calls in `tenants.withTenant(...)` get
 *                  per-tenant isolation for free.
 *   - `collection` Logical bucket — apps create one collection per
 *                  conceptual corpus (`articles`, `support_docs`,
 *                  per-user notebooks, ...).
 *   - `source_id`  Optional pointer back to the source row a chunk
 *                  came from. `deleteBySource(collection, id)`
 *                  drops every chunk for one source in a single
 *                  DELETE — handy when re-indexing on update.
 *   - `content`    The chunk text. Plain `text` for full storage.
 *   - `metadata`   Free-form JSONB. Indexable in the recommended
 *                  migration via a GIN index when apps query by
 *                  metadata filters.
 *   - `created_at` Insert timestamp. Useful for audit + soft
 *                  recency filtering.
 *
 * Columns attached by `applyRagVectorMigration`:
 *
 *   - `embedding vector(<dimension>) NOT NULL` — the vector itself.
 *   - `HNSW idx_<table>_embedding` on `(embedding vector_cosine_ops)`.
 *
 * Apps register the schema with `SchemaRegistry` at boot (mirrors
 * every other framework schema), then call
 * `applyRagVectorMigration(db, { dimension, registry })` inside
 * the migration's `up()`.
 */

import { Archetype, defineSchema } from '@strav/database'

export const ragVectorSchema = defineSchema(
  'rag_vector',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('collection').max(128).notNull()
    t.string('source_id').max(128).nullable()
    t.text('content').notNull()
    t.json('metadata').notNull().default({})
    t.timestamp('created_at').notNull()
  },
  { tenanted: true },
)
