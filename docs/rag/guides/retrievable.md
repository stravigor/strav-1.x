# `retrievable()` — repository mixin

The `retrievable(Repository<T>)` mixin bolts vector-index methods onto a Repository so apps re-index a row and search its collection without juggling `RagManager` calls by hand. Apps subclass the mixed-in class, override extension points where the defaults aren't right, and inject `RagManager` alongside the standard repository dependencies.

```ts
import { Repository } from '@strav/database'
import { PostgresDatabase } from '@strav/database'
import { EventBus, inject } from '@strav/kernel'
import { RagManager, retrievable } from '@strav/rag'

@inject()
export class ArticleRepository extends retrievable<Article, typeof Repository<Article>>(
  Repository<Article>,
) {
  static override readonly schema = articleSchema
  static override readonly model = Article

  constructor(db: PostgresDatabase, events: EventBus, rag: RagManager) {
    super(db, events)
    this.rag = rag
  }

  protected override toContent(a: Article): string {
    return `${a.title}\n\n${a.body}`
  }

  protected override toMetadata(a: Article): Record<string, unknown> {
    return { authorId: a.author_id, tags: a.tags }
  }
}
```

## What the mixin adds

- **`vectorize(model)`** — drops existing chunks for the model's id, chunks + embeds the current content, upserts. Returns the vector ids written.
- **`vectorRemove(model)`** — drops every chunk with the model's id.
- **`retrieve(query, options?)`** — semantic search over the repository's collection. Default `collection` is `collectionName()`.
- **`reindexAll(batchSize?)`** — walks every row in the repository, vectorizes each. Useful for backfilling a new collection or recovering after a schema change.
- **`resolveMatches(matches)`** — hydrates the source rows for retrieved matches in match order. Drops matches whose row was deleted since indexing.

## Extension points

All optional. Override to customize behavior.

| Method | Default | When to override |
|---|---|---|
| `collectionName()` | The table name from `static schema` | Multiple repos sharing one collection, dynamic per-tenant suffixes, etc. |
| `toContent(model)` | Concatenate every non-underscore string field with `\n` | Structured content (title + body), markdown rendering, derived text |
| `toMetadata(model)` | `{}` | Filterable fields (`author_id`, `lang`, `kind`, ...) |
| `shouldRetrieve(model)` | `true` | Gate drafts / soft-deleted / private rows |

```ts
// Skip draft + soft-deleted rows
protected override shouldRetrieve(a: Article): boolean {
  return a.published_at !== null && a.deleted_at === null
}
```

When `shouldRetrieve` returns `false`, the next `vectorize(model)` call **drops** existing chunks rather than re-ingesting. Apps don't need a separate "this just became private" code path.

## Auto-vectorize on save?

The mixin doesn't subscribe to repository lifecycle events. The reason: tying persistence to the embedding provider's availability means a transient rate-limit on the embedder would fail the `create` call. Apps that want auto-vectorize wire it themselves so they control the failure mode:

```ts
// Fire-and-forget (simplest; lose indexes on embedding failures)
events.on('article.created', (e) => {
  articles.vectorize(e.model).catch((err) => logger.warn({ err }, 'vectorize failed'))
})

// Queued via @strav/queue (resilient; index lag of seconds-to-minutes)
events.on('article.created', (e) => {
  queue.dispatch(new VectorizeArticleJob({ id: e.model.id }))
})
```

The queued pattern is the recommended production wiring.

## Resolving matches

`retrieve(query)` returns `RetrievedDocument[]` with metadata + content. To hydrate the source rows in match order:

```ts
const { matches } = await articles.retrieve(query)
const rows = await articles.resolveMatches(matches)

// rows[0] is the source Article for the highest-scoring match,
// rows[1] for the next, etc. Rows deleted since indexing are dropped.
```

## Re-indexing a corpus

After a chunker change, embedding model swap, or content migration, re-index every row:

```ts
const total = await articles.reindexAll(100)
console.log(`Re-indexed ${total} articles`)
```

Batches are loaded with `query().orderBy('id', 'asc').limit(batchSize).offset(...)`. For very large corpora, ship this from a CLI command or a queued job — `reindexAll` is synchronous within one process and can hit embedding rate limits on big runs.

## Why a mixin, not inheritance?

The mixin pattern preserves the user-side class's freedom to extend any specific `Repository<T>` subclass. Apps that already extend a custom base (auth-aware, tenant-aware, etc.) layer the mixin on top:

```ts
class ArticleRepository extends retrievable(MyTenantRepo<Article>) {
  // ...
}
```

The mixin only requires `query()`, `findMany(ids)`, and `static schema` from the base — every framework Repository satisfies that contract.

## CLI

`rag:reindex {name|--all}` resolves a registered retrievable through `RetrievableRegistry` and calls `reindexAll(batch)`. Register repos in a service provider:

```ts
import { RetrievableRegistry } from '@strav/rag'

const registry = app.resolve(RetrievableRegistry)
registry.register('articles', ArticleRepository)
```

Then `bun strav rag:reindex articles` or `bun strav rag:reindex --all`. See [CLI commands](./cli.md) for the full flag list and the `rag:flush` / `rag:list` companions.
