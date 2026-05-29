# Getting started

## Install

`@strav/rag` is bundled in the workspace lockstep — apps depend on it directly:

```json
{
  "dependencies": {
    "@strav/rag": "^1.0.0-alpha.18"
  }
}
```

It needs:
- **`@strav/brain`** — for embedding calls. Configure your provider in `config/brain.ts`.
- **`@strav/database`** — only when using the pgvector driver. The memory driver works without it.
- **PostgreSQL ≥ 16 with the `vector` extension** for production. Apt/Homebrew packages bundle pgvector with PG 16.

## Configure

```ts
// config/rag.ts
import { env } from '@strav/kernel'
import type { RagConfig } from '@strav/rag'

export default {
  default: env('RAG_DEFAULT', 'pg'),
  prefix: env('RAG_PREFIX', ''),   // optional namespace, e.g., 'app_' or per-env

  embedding: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimension: 1536,
  },

  chunking: {
    strategy: 'recursive',
    chunkSize: 512,
    overlap: 64,
  },

  stores: {
    pg: { driver: 'pgvector' },
    mem: { driver: 'memory' },
  },
} satisfies RagConfig
```

## Wire the providers

```ts
// bootstrap/providers.ts
export default [
  ConfigProvider,
  LoggerProvider,
  DatabaseProvider,    // before RagProvider when using pgvector
  BrainProvider,       // before RagProvider — rag depends on brain.embed()
  RagProvider,
]
```

`RagProvider` declares `dependencies = ['config', 'brain']`, so the topological boot order resolves itself even if you list providers in a different order.

## Run the migration

```ts
// database/migrations/20260601000000_create_rag_vector.ts
import { type Migration } from '@strav/database'
import { applyRagVectorMigration, ragVectorSchema } from '@strav/rag'
import { emitDropTable } from '@strav/database'

export const migration: Migration = {
  name: '20260601000000_create_rag_vector',
  async up(db, { registry }) {
    await applyRagVectorMigration(db, {
      dimension: 1536,   // must match config.rag.embedding.dimension
      registry,
    })
  },
  async down(db) {
    await db.execute(emitDropTable(ragVectorSchema.name).sql)
  },
}
```

Register the schema with the registry at boot:

```ts
import { SchemaRegistry } from '@strav/database'
import { ragVectorSchema } from '@strav/rag'

app.resolve(SchemaRegistry).registerAll([ragVectorSchema])
```

Then `bun strav migrate` applies it.

## First ingest

```ts
import { RagManager } from '@strav/rag'

const rag = app.resolve(RagManager)

// Ingest some content. The manager chunks it, embeds each chunk via
// the configured brain provider, and upserts into pgvector.
const ids = await rag.ingest('articles', `
  Compaction lets long Anthropic conversations stay in context budget
  by summarizing the older turns into a single block. Apps round-trip
  the block on subsequent requests and the older raw turns drop out.
`, {
  sourceId: 'article_42',
  metadata: { tags: ['compaction', 'anthropic'] },
})

console.log(ids)
// ['<ulid>_0', '<ulid>_1', ...]
```

## First retrieve

```ts
const { matches } = await rag.retrieve('How do I keep long threads in budget?', {
  collection: 'articles',
  topK: 3,
})

for (const m of matches) {
  console.log(`[${m.score.toFixed(3)}]`, m.content.slice(0, 100))
}
```

Scores are normalized to `[0, 1]` so memory and pgvector return comparable values (cosine similarity mapped from `[-1, 1]`).

## Use the retrieved context

```ts
const { matches } = await rag.retrieve(userQuestion, { collection: 'articles', topK: 5 })

const context = matches
  .map((m, i) => `[${i + 1}] ${m.content}`)
  .join('\n\n')

const { text } = await brain.chat(
  `Use the context below to answer the user's question.\n\n` +
  `Context:\n${context}\n\n` +
  `Question: ${userQuestion}`,
  { system: 'You answer based on the provided context. Say "I don\'t know" when unsupported.' },
)
```

## Resetting a source

When the underlying source row changes, drop its chunks and re-ingest:

```ts
await rag.store().deleteBySource('articles', article.id)
await rag.ingest('articles', article.body, { sourceId: article.id })
```

A dedicated `retrievable()` repository mixin that does this automatically on `repo.update(...)` is on the roadmap.

## Dev vs prod stores

Apps switching between local dev (memory) and prod (pgvector):

```ts
// config/rag.ts
{
  default: env('RAG_DEFAULT', 'mem'),   // mem in dev, pg in prod
  stores: {
    mem: { driver: 'memory' },
    pg:  { driver: 'pgvector' },
  },
  // ...
}
```

`RAG_DEFAULT=pg` in `.env.production`, `mem` in `.env.development`. The memory driver doesn't need a migration and dies with the process — perfect for unit tests.
