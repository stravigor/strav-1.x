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

A built-in `rag:reindex <repository>` command isn't in V1 because the framework can't resolve a repository name to an instance generically (apps register repos under arbitrary container keys). Apps that want one ship a thin custom command:

```ts
import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { ArticleRepository } from '../app/repositories/article_repository.ts'

export class ReindexArticles extends Command {
  static signature = 'app:reindex-articles'
  static description = 'Re-index every article into RAG.'
  static providers = ['config', 'logger', 'database', 'brain', 'rag']

  override async execute(_args: ExecuteArgs): Promise<number> {
    const articles = this.app.resolve(ArticleRepository)
    const total = await articles.reindexAll(100)
    this.success(`Re-indexed ${total} article(s).`)
    return ExitCode.Success
  }
}
```

## What's NOT in V1

- **`rag:reindex <repository>`** — see above. Apps ship custom commands.
- **`rag:show <id>`** — inspect a single vector. Not built. Apps drop down to raw SQL or driver-specific tooling.
- **`rag:stats`** — per-collection vector counts. Could be a one-line SQL query in the meantime: `SELECT collection, COUNT(*) FROM rag_vector GROUP BY collection`.
