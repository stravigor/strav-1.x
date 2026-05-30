# CLI commands

`@strav/rag` ships two console commands and a `RagConsoleProvider` apps register alongside `RagProvider` to expose them.

## Wiring

```ts
// bootstrap/providers.ts
import { RagProvider, RagConsoleProvider } from '@strav/rag'

export default [
  ConfigProvider,
  LoggerProvider,
  DatabaseProvider,
  BrainProvider,
  RagProvider,
  RagConsoleProvider,
]
```

Once registered, the commands appear in `bun strav --help` alongside the rest of the framework's commands.

## `bun strav rag:list`

Diagnostic — print the configured RAG stores, embedding settings, and chunking config. No mutations.

```
$ bun strav rag:list
Default store: pg
Collection prefix: app_

Stores:
  pg (default): driver=pgvector
  mem: driver=memory

Embedding:
  provider: openai
  model:    text-embedding-3-small
  dim:      1536

Chunking:
  strategy:  recursive
  chunkSize: 512
  overlap:   64
```

Use it to verify `config/rag.ts` parses correctly + the registered driver names match what you expect.

## `bun strav rag:flush <collection> [--store=name] [--force]`

Delete every vector in a collection on the active (or named) store.

```
$ bun strav rag:flush articles
Delete every vector in collection "app_articles" on store "pg"? This is irreversible. [y/N]
```

The configured collection prefix is applied — `rag:flush articles` on a config with `prefix: 'app_'` targets `app_articles`. The confirmation message shows the resolved full collection name to make this visible.

### Flags

- **`--force`** — skip the confirmation prompt. Required in non-interactive contexts (CI cleanup, scripted teardown).
- **`--store=<name>`** — route to a named store other than the default. Useful when you have both `pg` and `mem` configured and want to flush the in-memory cache without touching the persistent store.

### What it doesn't do

`rag:flush` only drops vectors. It doesn't touch the source rows — apps re-index from the source after a flush:

```bash
bun strav rag:flush articles --force
bun strav app:reindex-articles    # your custom command calling repo.reindexAll()
```

## `rag:reindex {name?} [--all] [--batch=100]`

Re-vectorize a repository (or every registered one). Apps register their retrievable repositories with `RetrievableRegistry` at boot; the command resolves the registered class through the container and calls `reindexAll(batchSize)`.

```ts
// In a service provider's register():
import { RetrievableRegistry } from '@strav/rag'
import { ArticleRepository } from '../app/repositories/article_repository.ts'

const registry = app.resolve(RetrievableRegistry)
registry.register('articles', ArticleRepository)
```

Then:

```bash
bun strav rag:reindex articles            # one repo
bun strav rag:reindex articles --batch=25 # tune batch size
bun strav rag:reindex --all               # every registered repo
```

The repo class must implement `reindexAll(batchSize?: number): Promise<number>` — the `retrievable()` mixin provides exactly that shape. The default batch size is 100; drop lower when hitting embedding rate limits.

### Flags

- **`--all`** — re-index every repository registered in `RetrievableRegistry`.
- **`--batch=N`** — rows per fetch + embed batch. Default `100`.

### Limitations

- Long-running on large corpora — apps with multi-million-row tables typically wire reindex to a queued worker pointing at the same `reindexAll(...)` rather than running it in-process.
- No progress bar; the command prints one line per repository on completion.

## What's NOT in V1

- **`rag:show <id>`** — inspect a single vector. Not built. Apps drop down to raw SQL or driver-specific tooling.
- **`rag:stats`** — per-collection vector counts. Could be a one-line SQL query in the meantime: `SELECT collection, COUNT(*) FROM rag_vector GROUP BY collection`.
