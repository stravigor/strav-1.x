/**
 * `ArticleRepository` — the e2e's domain repository, with the
 * `retrievable()` mixin layered on. Demonstrates the canonical
 * 1.x wiring:
 *
 *   - extend `retrievable(Repository<Article>)`
 *   - declare static schema + model
 *   - declare an explicit constructor that takes the standard
 *     Repository deps PLUS RagManager, and assign `this.rag`
 *   - override `toContent` / `toMetadata` to build the
 *     indexable text + filterable metadata from the row shape
 */

// biome-ignore lint/style/useImportType: classes are value imports for @inject() metadata.
import { PostgresDatabase, Repository } from '@strav/database'
// biome-ignore lint/style/useImportType: same.
import { EventBus, inject } from '@strav/kernel'
// biome-ignore lint/style/useImportType: same.
import { RagManager, retrievable } from '@strav/rag'
import { articleSchema } from '../database/schemas/article_schema.ts'
import { Article } from './article.ts'

// Repository<T> is `abstract` at the type level; the mixin's
// generic bound demands a non-abstract constructor. The cast is
// a typing-only formality — at runtime apps subclass Repository
// in exactly this pattern.
// biome-ignore lint/suspicious/noExplicitAny: typing-only cast.
type RepoCtor = new (...args: any[]) => Repository<Article>
const RepoBase = Repository as unknown as RepoCtor

@inject()
export class ArticleRepository extends retrievable<Article, RepoCtor>(RepoBase) {
  static readonly schema = articleSchema
  static readonly model = Article

  constructor(db: PostgresDatabase, events: EventBus, rag: RagManager) {
    super(db, events)
    this.rag = rag
  }

  protected override collectionName(): string {
    return 'article'
  }

  protected override toContent(a: Article): string {
    return `${a.title}\n\n${a.body}`
  }

  protected override toMetadata(a: Article): Record<string, unknown> {
    return { title: a.title }
  }
}
