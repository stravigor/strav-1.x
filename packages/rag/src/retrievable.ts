/**
 * `retrievable(Repository)` — class mixin that bolts vector-index
 * methods onto a Repository so apps can re-index a row and search
 * its collection without juggling `RagManager` calls by hand.
 *
 * ```ts
 * @inject()
 * export class ArticleRepository extends retrievable(Repository<Article>) {
 *   static override readonly schema = articleSchema
 *   static override readonly model = Article
 *
 *   constructor(db: PostgresDatabase, events: EventBus, rag: RagManager) {
 *     super(db, events)
 *     this.rag = rag
 *   }
 *
 *   // Override the extension points as needed:
 *   protected override toContent(a: Article): string {
 *     return `${a.title}\n\n${a.body}`
 *   }
 *
 *   protected override toMetadata(a: Article): Record<string, unknown> {
 *     return { authorId: a.author_id, tags: a.tags }
 *   }
 * }
 * ```
 *
 * Usage:
 *
 * ```ts
 * const article = await articles.create(...)
 * await articles.vectorize(article)              // index it
 *
 * const { matches } = await articles.retrieve('query')   // search
 *
 * await articles.delete(article)
 * await articles.vectorRemove(article)           // drop from index
 * ```
 *
 * Why not auto-vectorize on `create` / `update`?
 *
 *   V1 ships the explicit pattern. An auto-hook tied to repository
 *   events would couple persistence to the embedding provider's
 *   availability — a transient rate-limit on the embedder would
 *   fail the create call. Apps that want auto-vectorize wire it
 *   themselves via `events.on('article.created', m =>
 *   articles.vectorize(m))` so they control the failure mode
 *   (fire-and-forget vs awaited vs queued via `@strav/queue`).
 *
 * Extension points (all optional overrides):
 *
 *   - `collectionName()` — defaults to the table name from the
 *     schema. Override when the collection should differ from the
 *     table, or to compose a per-tenant suffix dynamically.
 *
 *   - `toContent(model)` — defaults to concatenating every string
 *     field on the model with `\n`. The default works for simple
 *     row shapes; apps with structured content override.
 *
 *   - `toMetadata(model)` — defaults to `{}`. Apps return fields
 *     they want to filter on (e.g. `author_id`, `lang`, `kind`).
 *
 *   - `shouldRetrieve(model)` — gates indexing. Return `false` for
 *     draft / soft-deleted / private rows. The default is `true`.
 */

import type { Repository } from '@strav/database'
import type { RagManager } from './rag_manager.ts'
import type {
  RetrieveOptions,
  RetrieveResult,
  VectorMatch,
} from './types.ts'

/** Minimal constructor type we can mix into. Wider than `typeof Repository` so subclasses with extra ctor args still type-check. */
// biome-ignore lint/suspicious/noExplicitAny: mixin constructor signatures intentionally accept any[]; the user-side subclass narrows.
type RepositoryConstructor<TModel extends object> = new (...args: any[]) => Repository<TModel>

/**
 * Returns a subclass that extends `Base` with `vectorize` /
 * `vectorRemove` / `retrieve` plus override-points
 * (`collectionName`, `toContent`, `toMetadata`,
 * `shouldRetrieve`). The user-side class declares an explicit
 * constructor that calls `super(...)` and assigns `this.rag`.
 */
export function retrievable<TModel extends object, TBase extends RepositoryConstructor<TModel>>(
  Base: TBase,
) {
  abstract class RetrievableRepository extends Base {
    /**
     * The framework's `RagManager`. Assigned by the user-side
     * subclass constructor. Public on purpose — apps that want to
     * drop down to raw `rag.store()` / `rag.ingest(...)` access
     * have a hook.
     */
    rag!: RagManager

    /**
     * Collection name for vector storage. Defaults to the table
     * name from `static schema`. Override to point at a different
     * collection (or to compose per-tenant / per-env suffixes).
     */
    protected collectionName(): string {
      const ctor = this.constructor as unknown as { schema: { name: string } }
      return ctor.schema.name
    }

    /**
     * Build the indexable text from a model row. Default
     * concatenates every non-underscore string field with `\n`.
     * Apps with structured content override this — typically
     * something like `` `${a.title}\n\n${a.body}` ``.
     */
    protected toContent(model: TModel): string {
      const parts: string[] = []
      for (const [key, value] of Object.entries(model as Record<string, unknown>)) {
        if (key.startsWith('_')) continue
        if (typeof value === 'string' && value.length > 0) parts.push(value)
      }
      return parts.join('\n')
    }

    /**
     * Build the metadata bag attached to every chunk. Apps return
     * fields they want to filter retrievals on. The framework
     * automatically adds `chunkIndex`, `startOffset`, `endOffset`
     * — overrides shouldn't try to re-add those.
     */
    protected toMetadata(_model: TModel): Record<string, unknown> {
      return {}
    }

    /**
     * Whether the model should currently be indexed. Override to
     * skip drafts, soft-deleted rows, private records, etc. The
     * default `true` indexes every model — fine for the common
     * case.
     */
    protected shouldRetrieve(_model: TModel): boolean {
      return true
    }

    /**
     * (Re-)index a single model. Drops any existing chunks for
     * the model's id, then ingests fresh chunks of the current
     * content. When `shouldRetrieve(model)` returns `false`, the
     * chunks are dropped without re-ingest — apps don't need a
     * separate "this just became private" path.
     *
     * Returns the vector ids written. Empty array when content
     * was empty or `shouldRetrieve` returned `false`.
     */
    async vectorize(model: TModel): Promise<string[]> {
      const collection = this.collectionName()
      const id = modelId(model)

      // Drop existing chunks for this source first so updates
      // replace cleanly. (RagManager.ingest writes fresh ids per
      // call; without this step every re-vectorize would
      // duplicate.)
      await this.rag
        .store()
        .deleteBySource(this.rag.collectionName(collection), id)

      if (!this.shouldRetrieve(model)) return []

      const content = this.toContent(model)
      if (!content) return []

      return this.rag.ingest(collection, content, {
        sourceId: id,
        metadata: this.toMetadata(model),
      })
    }

    /**
     * Drop every chunk for one model. Apps call this after
     * `delete(model)` in their domain code. The mixin doesn't
     * auto-hook the delete lifecycle for the same reason it
     * doesn't auto-hook create/update — keeps embedding-provider
     * availability out of the persistence path.
     */
    async vectorRemove(model: TModel): Promise<void> {
      const collection = this.collectionName()
      const id = modelId(model)
      await this.rag
        .store()
        .deleteBySource(this.rag.collectionName(collection), id)
    }

    /**
     * Semantic search over this repository's collection. Default
     * `collection` is the mixin's `collectionName()` — apps that
     * want to retrieve from another collection pass it explicitly.
     */
    async retrieve(
      query: string,
      options: Omit<RetrieveOptions, 'collection'> & { collection?: string } = {},
    ): Promise<RetrieveResult> {
      return this.rag.retrieve(query, {
        ...options,
        collection: options.collection ?? this.collectionName(),
      })
    }

    /**
     * Re-index every row in the repository. Walks rows in batches
     * of `batchSize` and vectorizes each. Useful for backfilling
     * a new collection or recovering after a schema change.
     *
     * The CLI's `rag:reindex <repository>` doesn't ship in V1 —
     * apps that want one wire it as their own console command
     * pointing at this method.
     *
     * Returns the total count of rows processed (NOT the chunk
     * count — chunks per row vary with content size).
     */
    async reindexAll(batchSize: number = 100): Promise<number> {
      let processed = 0
      let offset = 0
      while (true) {
        const rows = await this.query().orderBy('id', 'asc').limit(batchSize).offset(offset).get()
        if (rows.length === 0) break
        for (const row of rows) await this.vectorize(row)
        processed += rows.length
        offset += rows.length
        if (rows.length < batchSize) break
      }
      return processed
    }

    /**
     * Match-to-models helper. Takes the `matches` array from
     * `retrieve(...)` and hydrates the source rows by id, in
     * match order. Matches whose `sourceId` doesn't resolve to a
     * row (deleted between index time + retrieval) are dropped.
     */
    async resolveMatches(matches: readonly VectorMatch[]): Promise<TModel[]> {
      const ids = [...new Set(matches.map((m) => m.sourceId).filter((s): s is string => !!s))]
      if (ids.length === 0) return []
      const found = await this.findMany(ids as unknown as readonly string[])
      const byId = new Map<string, TModel>(
        found.map((m) => [modelId(m), m]),
      )
      const out: TModel[] = []
      for (const match of matches) {
        if (!match.sourceId) continue
        const row = byId.get(match.sourceId)
        if (row) out.push(row)
      }
      return out
    }
  }
  return RetrievableRepository
}

/**
 * Coerce a model's `id` to a string. Repositories use ULID or UUID
 * ids by default, both of which round-trip through `String(...)`
 * cleanly; integer PKs (bigSerial) coerce the same way.
 */
function modelId(model: object): string {
  const id = (model as { id?: unknown }).id
  if (id === undefined || id === null) {
    throw new Error(
      `retrievable: model has no \`id\` to use as a vector sourceId. The mixin only works on models with a single-column id.`,
    )
  }
  return String(id)
}
