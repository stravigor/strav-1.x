/**
 * `ArticleRepository` — the e2e's domain repository, with the
 * `retrievable()` mixin layered on. Demonstrates the canonical
 * 1.x wiring:
 *
 *   - extend `retrievable(Repository<Article>)`
 *   - declare static schema + model
 *   - declare an explicit constructor that takes the standard
 *     `RepositoryOptions` bag PLUS RagManager, and assign `this.rag`
 *   - override `toContent` / `toMetadata` to build the
 *     indexable text + filterable metadata from the row shape
 */

import { Repository, type RepositoryOptions } from '@strav/database'
// biome-ignore lint/style/useImportType: RagManager is needed at runtime — it's stored on `this.rag`.
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

export class ArticleRepository extends retrievable<Article, RepoCtor>(RepoBase) {
  static readonly schema = articleSchema
  static readonly model = Article

  constructor(options: RepositoryOptions, rag: RagManager) {
    super(options)
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
